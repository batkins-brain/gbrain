/**
 * Reconcile-refusal audit log (observability only).
 *
 * The floor guard added in v0.42.59.0 makes the 2026-08-17 data-loss path
 * non-destructive, but a refusal was only announced on stdout — no timestamp,
 * no durable sink. Since a refusal IS the still-unidentified trigger
 * reproducing safely, losing it to a terminal buffer would waste the best
 * evidence available.
 *
 * These tests pin the properties that make the audit trustworthy: it fires on
 * refusal and only on refusal, it carries the fields needed to reconstruct the
 * event, it never leaks content or secrets, and — most importantly — its own
 * failure cannot alter reconcile behaviour.
 *
 * Env is mutated only through the repo-canonical `withEnv` helper: process.env
 * is process-global and the parallel runner loads many test files into one
 * process (enforced by scripts/check-test-isolation.sh).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withEnv } from './helpers/with-env.ts';
import {
  logReconcileRefusal,
  summarizeInvocation,
  describeCheckout,
  computeReconcileRefusalAuditFilename,
} from '../src/core/reconcile-refusal-audit.ts';
import { assessReconcileSweep } from '../src/core/reconcile-floor.ts';

let auditDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-refusal-audit-'));
});

afterEach(() => {
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Run `fn` with the audit sink pointed at `dir`, via the canonical helper. */
function withAuditDir<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_AUDIT_DIR: dir }, fn);
}

function readRecords(dir: string = auditDir): any[] {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return files
    .filter(f => f.startsWith('reconcile-refusal-') && f.endsWith('.jsonl'))
    .flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean))
    .map(l => JSON.parse(l));
}

const BASE = {
  sourceId: 'tf-brain-vault',
  repoPath: '/home/example/repos/tf-brain',
  enumeratedCount: 0,
  fileBackedCount: 4563,
  staleCount: 4563,
  ratio: 1,
  argv: ['sync', '--full', '--source', 'tf-brain-vault'],
};

describe('reconcile refusal audit', () => {
  test('empty_enumeration refusal emits a record', async () => {
    await withAuditDir(auditDir, () => {
      logReconcileRefusal({ ...BASE, reason: 'empty_enumeration' });
    });
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].reason).toBe('empty_enumeration');
  });

  test('bulk_delete_ratio refusal emits a record', async () => {
    await withAuditDir(auditDir, () => {
      logReconcileRefusal({
        ...BASE, reason: 'bulk_delete_ratio',
        enumeratedCount: 100, fileBackedCount: 1000, staleCount: 900, ratio: 0.9,
      });
    });
    const r = readRecords()[0];
    expect(r.reason).toBe('bulk_delete_ratio');
    expect(r.enumerated_count).toBe(100);
    expect(r.stale_count).toBe(900);
    expect(r.file_backed_count).toBe(1000);
  });

  test('a successful reconcile emits NOTHING', async () => {
    // The guard allows: 5 of 500 stale, non-empty enumeration. The production
    // call site is gated on `!floor.allowed`, so nothing is logged.
    const floor = assessReconcileSweep({ enumeratedCount: 495, fileBackedCount: 500, staleCount: 5 });
    expect(floor.allowed).toBe(true);
    await withAuditDir(auditDir, () => {
      if (!floor.allowed && floor.reason) logReconcileRefusal({ ...BASE, reason: floor.reason });
    });
    expect(readRecords()).toHaveLength(0);
  });

  test('record carries a UTC timestamp and the attribution fields', async () => {
    await withAuditDir(auditDir, () => {
      logReconcileRefusal({ ...BASE, reason: 'empty_enumeration', strategy: 'markdown' });
    });
    const r = readRecords()[0];
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Number.isFinite(Date.parse(r.ts))).toBe(true);
    expect(r.source_id).toBe('tf-brain-vault');
    expect(r.repo_path).toBe('/home/example/repos/tf-brain');
    expect(r.enumerated_count).toBe(0);
    expect(r.file_backed_count).toBe(4563);
    expect(r.stale_count).toBe(4563);
    expect(r.strategy).toBe('markdown');
    expect(typeof r.pid).toBe('number');
    expect(typeof r.ppid).toBe('number');
    expect(typeof r.hostname).toBe('string');
    expect(r.invocation).toContain('--full');
    // git fields are present even when unresolvable, so the shape is stable.
    expect(r).toHaveProperty('git_head');
    expect(r).toHaveProperty('git_branch');
  });

  test('records whether the repo path resolved — an empty read may be a vanished mount', async () => {
    const real = mkdtempSync(join(tmpdir(), 'gbrain-realrepo-'));
    try {
      await withAuditDir(auditDir, () => {
        logReconcileRefusal({ ...BASE, reason: 'empty_enumeration', repoPath: real });
      });
      const r = readRecords()[0];
      expect(r.repo_path_exists).toBe(true);
      expect(r.repo_path_is_dir).toBe(true);
    } finally { rmSync(real, { recursive: true, force: true }); }
  });

  test('a missing repo path is recorded, not thrown', async () => {
    await withAuditDir(auditDir, () => {
      logReconcileRefusal({ ...BASE, reason: 'empty_enumeration', repoPath: '/nonexistent/path/xyz' });
    });
    const r = readRecords()[0];
    expect(r.repo_path_exists).toBe(false);
    expect(r.repo_path_is_dir).toBe(false);
  });

  test('audit-write failure does NOT throw — behaviour cannot change', async () => {
    // Audit dir resolves under a FILE, so mkdir must fail.
    const blocker = join(auditDir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    await withAuditDir(join(blocker, 'nested'), () => {
      expect(() => logReconcileRefusal({ ...BASE, reason: 'empty_enumeration' })).not.toThrow();
    });
  });

  test('audit-write failure on an unwritable directory does NOT throw', async () => {
    const ro = mkdtempSync(join(tmpdir(), 'gbrain-ro-audit-'));
    try {
      chmodSync(ro, 0o500); // r-x: cannot create files
      await withAuditDir(ro, () => {
        expect(() => logReconcileRefusal({ ...BASE, reason: 'empty_enumeration' })).not.toThrow();
      });
    } finally { chmodSync(ro, 0o700); rmSync(ro, { recursive: true, force: true }); }
  });

  test('no secrets, env values, or page content reach the record', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir, GBRAIN_FAKE_SECRET: 'super-secret-value-xyz' }, () => {
      logReconcileRefusal({
        ...BASE, reason: 'empty_enumeration',
        argv: [
          'sync', '--full',
          // hostile argv: none of this may survive into the record
          '--database-url', 'postgresql://user:PASSWORD123@host:5432/db',
          '--token', 'ghp_SECRETTOKENVALUE',
          '--unknown-flag', 'some page content that should never be logged',
        ],
      });
    });
    const raw = JSON.stringify(readRecords()[0]);
    expect(raw).not.toContain('PASSWORD123');
    expect(raw).not.toContain('ghp_SECRETTOKENVALUE');
    expect(raw).not.toContain('postgresql://');
    expect(raw).not.toContain('super-secret-value-xyz');
    expect(raw).not.toContain('page content that should never be logged');
    // ...while still keeping the safe, useful part
    expect(readRecords()[0].invocation).toContain('--full');
  });

  test('summarizeInvocation allow-lists rather than sanitizes', () => {
    expect(summarizeInvocation(['sync', '--all', '--full'])).toBe('sync --all --full');
    expect(summarizeInvocation(['sync', '--source', 'tf-brain-vault'])).toBe('sync --source tf-brain-vault');
    expect(summarizeInvocation(['sync', '--source=paperclip'])).toBe('sync --source paperclip');
    // unknown flags AND their values are dropped, not escaped
    expect(summarizeInvocation(['sync', '--secret', 'abc'])).toBe('sync');
    // a value that isn't a bounded identifier is dropped; the flag is kept
    expect(summarizeInvocation(['sync', '--source', 'postgres://u:p@h/db'])).toBe('sync --source');
    expect(summarizeInvocation([])).toBe('sync');
  });

  test('filename follows the existing ISO-week audit convention', () => {
    // Same shape as stub-guard-YYYY-Www.jsonl, different prefix.
    expect(computeReconcileRefusalAuditFilename(new Date('2026-08-17T12:00:00Z')))
      .toBe('reconcile-refusal-2026-W34.jsonl');
    // ISO year-boundary: 2027-01-01 falls in ISO week 53 of 2026.
    expect(computeReconcileRefusalAuditFilename(new Date('2027-01-01T12:00:00Z')))
      .toBe('reconcile-refusal-2026-W53.jsonl');
  });

  test('writes under GBRAIN_AUDIT_DIR, honouring the existing convention', async () => {
    await withAuditDir(auditDir, () => {
      logReconcileRefusal({ ...BASE, reason: 'empty_enumeration' });
    });
    const files = readdirSync(auditDir).filter(f => f.startsWith('reconcile-refusal-'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^reconcile-refusal-\d{4}-W\d{2}\.jsonl$/);
  });

  test('appends rather than truncates, and every line is valid JSON', async () => {
    await withAuditDir(auditDir, () => {
      logReconcileRefusal({ ...BASE, reason: 'empty_enumeration' });
      logReconcileRefusal({ ...BASE, reason: 'bulk_delete_ratio' });
    });
    const file = join(auditDir, readdirSync(auditDir).find(f => f.startsWith('reconcile-refusal-'))!);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(lines.map(l => JSON.parse(l).reason)).toEqual(['empty_enumeration', 'bulk_delete_ratio']);
  });

  test('describeCheckout resolves a real repo and returns nulls for a non-repo', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'gbrain-nonrepo-'));
    try {
      const r = describeCheckout(nonRepo);
      expect(r.head).toBeNull();
      expect(r.branch).toBeNull();
    } finally { rmSync(nonRepo, { recursive: true, force: true }); }
    const here = describeCheckout(join(import.meta.dir, '..'));
    expect(here.head).toMatch(/^[0-9a-f]{40}$/);
  });

  test('the sync call site is gated on refusal and passes the guard\'s own counts', () => {
    // Proves the wiring: logged only under !floor.allowed, fed real values.
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'sync.ts'), 'utf8');
    expect(src).toContain('logReconcileRefusal');
    expect(src.indexOf('if (!floor.allowed)')).toBeLessThan(src.indexOf('logReconcileRefusal({'));
    expect(src).toContain('enumeratedCount: floor.enumeratedCount');
    expect(src).toContain('fileBackedCount: floor.fileBackedCount');
    expect(src).toContain('staleCount: floor.staleCount');
    // must not fabricate an attribution
    expect(src).not.toContain("floor.reason ?? 'empty_enumeration'");
  });
});
