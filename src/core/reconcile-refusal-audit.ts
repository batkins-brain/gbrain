/**
 * Reconcile-refusal audit log. JSONL, ISO-week-rotated, best-effort.
 *
 * Writes one line per refusal to
 *   `${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/reconcile-refusal-YYYY-Www.jsonl`
 * when the full-sync reconcile floor guard (`src/core/reconcile-floor.ts`)
 * declines to delete.
 *
 * WHY THIS EXISTS. On 2026-08-17 the reconcile sweep emptied a production
 * brain (11,496 pages to 34) because the working-tree enumeration came back
 * empty and "no files here" was treated as "every file was deleted". The floor
 * guard added in v0.42.59.0 makes that outcome non-destructive: the sweep now
 * refuses. But the refusal itself was only announced on STDOUT with no
 * timestamp and no durable sink, so the conditions that produced it — the
 * thing nobody has been able to identify — would evaporate with the terminal
 * buffer.
 *
 * The guard prevents the damage. This makes the cause diagnosable. A refusal
 * IS the trigger reproducing, safely, and it is the highest-value evidence
 * available for the still-open root-cause investigation.
 *
 * STRICTLY OBSERVABILITY. This module never mutates the database, never
 * influences the guard's decision, and never changes which pages are
 * considered stale. `logReconcileRefusal` is called AFTER the refusal has
 * already been decided, and its own failure is swallowed — an audit sink that
 * can fail a sync would be a worse bug than the one it documents.
 *
 * PAYLOAD DISCIPLINE. Deliberately records counts, identifiers and paths —
 * never page content, never bind parameters, never credentials, and never the
 * environment wholesale. Invocation is reconstructed from an ALLOW-LIST of
 * recognized sync flags rather than by copying argv, so a stray
 * `--database-url=...` or similar can never reach the log. Repo paths are
 * recorded because the whole question is which tree was read.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveAuditDir } from './minions/handlers/shell-audit.ts';
import type { ReconcileRefusal } from './reconcile-floor.ts';

export interface ReconcileRefusalEvent {
  /** ISO-8601 UTC timestamp of the refusal. */
  ts: string;
  /** Which guard rule declined. */
  reason: ReconcileRefusal;
  /** Source whose sweep was refused. */
  source_id: string;
  /** The working tree that was enumerated. The central forensic field. */
  repo_path: string;
  /** Whether that path resolved at refusal time (an empty read may be a vanished mount). */
  repo_path_exists: boolean;
  repo_path_is_dir: boolean;
  /** Checkout identity where resolvable; null when not a git tree or git is unavailable. */
  git_head: string | null;
  git_branch: string | null;
  /** Files the working-tree enumeration returned. 0 is the 2026-08-17 shape. */
  enumerated_count: number;
  /** Sweep-eligible pages (non-null source_path) for this source. */
  file_backed_count: number;
  /** How many the sweep would have deleted. */
  stale_count: number;
  /** stale_count / file_backed_count, 0 when nothing to divide. */
  ratio: number;
  /** Process identity, to correlate with cron/systemd/agent runs. */
  pid: number;
  ppid: number;
  hostname: string;
  /** Recognized sync flags only — NEVER raw argv. */
  invocation: string;
  /** Sync strategy in effect, when known. */
  strategy: string | null;
}

/**
 * Sync flags worth recording. An ALLOW-LIST, not a filter: anything not named
 * here is dropped, so no unanticipated argument (a URL, a token, a path with
 * embedded credentials) can reach the audit file.
 */
const RECOGNIZED_FLAGS = new Set([
  '--all', '--full', '--dry-run', '--no-pull', '--no-embed', '--no-extract',
  '--skip-failed', '--retry-failed', '--no-schema-pack', '--allow-bulk-delete',
  '--watch', '--json', '--yes',
]);

/** Flags whose VALUE is a safe, bounded identifier worth keeping. */
const RECOGNIZED_VALUE_FLAGS = new Set(['--source', '--strategy', '--concurrency']);

/**
 * Reconstruct the invocation from recognized flags only.
 *
 * Values are kept for `--source`/`--strategy`/`--concurrency` because they are
 * bounded identifiers that materially change which tree is swept. Everything
 * else is dropped rather than sanitized: a drop cannot leak, a sanitizer can.
 */
export function summarizeInvocation(argv: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (RECOGNIZED_FLAGS.has(a)) { out.push(a); continue; }
    if (RECOGNIZED_VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      // Only keep a value that looks like a bounded identifier.
      if (v !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(v)) { out.push(`${a} ${v}`); i++; }
      else out.push(a);
      continue;
    }
    // `--source=x` / `--strategy=y` inline form.
    const eq = a.indexOf('=');
    if (eq > 0 && RECOGNIZED_VALUE_FLAGS.has(a.slice(0, eq))) {
      const k = a.slice(0, eq); const v = a.slice(eq + 1);
      if (/^[A-Za-z0-9._-]{1,64}$/.test(v)) out.push(`${k} ${v}`);
      else out.push(k);
    }
  }
  return out.length > 0 ? `sync ${out.join(' ')}` : 'sync';
}

/** Best-effort checkout identity. Never throws; returns nulls when unresolvable. */
export function describeCheckout(repoPath: string): { head: string | null; branch: string | null } {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch { return null; }
  };
  return { head: run(['rev-parse', 'HEAD']), branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

/**
 * Compute the ISO-8601 week filename `reconcile-refusal-YYYY-Www.jsonl`.
 * Mirrors `stub-guard-audit.ts` verbatim (which in turn mirrors
 * `shell-audit.ts`); the helper can't be shared because each hardcodes its
 * own filename prefix.
 */
export function computeReconcileRefusalAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday (ISO week anchor)
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  return `reconcile-refusal-${isoYear}-W${String(weekNum).padStart(2, '0')}.jsonl`;
}

export interface LogReconcileRefusalInput {
  reason: ReconcileRefusal;
  sourceId: string;
  repoPath: string;
  enumeratedCount: number;
  fileBackedCount: number;
  staleCount: number;
  ratio: number;
  strategy?: string | null;
  /** Injectable for tests; defaults to the real process argv. */
  argv?: readonly string[];
}

/**
 * Append one refusal to the ISO-week rotated JSONL file.
 *
 * BEST-EFFORT BY CONTRACT. Every failure mode — unwritable directory, full
 * disk, a throwing `stat`, a hung `git` — is swallowed and reported to stderr.
 * The caller has already refused the sweep; nothing this function does may
 * change that outcome or propagate an error into the sync.
 */
export function logReconcileRefusal(input: LogReconcileRefusalInput): void {
  try {
    let exists = false;
    let isDir = false;
    try {
      const st = fs.statSync(input.repoPath);
      exists = true;
      isDir = st.isDirectory();
    } catch { /* path gone — itself a finding, recorded as false/false */ }

    const { head, branch } = describeCheckout(input.repoPath);

    const event: ReconcileRefusalEvent = {
      ts: new Date().toISOString(),
      reason: input.reason,
      source_id: input.sourceId,
      repo_path: input.repoPath,
      repo_path_exists: exists,
      repo_path_is_dir: isDir,
      git_head: head,
      git_branch: branch,
      enumerated_count: input.enumeratedCount,
      file_backed_count: input.fileBackedCount,
      stale_count: input.staleCount,
      ratio: input.ratio,
      pid: process.pid,
      ppid: process.ppid,
      hostname: os.hostname(),
      invocation: summarizeInvocation(input.argv ?? process.argv.slice(2)),
      strategy: input.strategy ?? null,
    };

    const dir = resolveAuditDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, computeReconcileRefusalAuditFilename()),
      JSON.stringify(event) + '\n',
      { encoding: 'utf8' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[reconcile-refusal-audit] write failed (${msg}); continuing\n`);
  }
}
