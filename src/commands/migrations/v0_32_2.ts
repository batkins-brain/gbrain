/**
 * v0.32.2 migration orchestrator — facts join the system-of-record invariant.
 *
 * Schema migration v51 (src/core/migrate.ts) added the two fence columns
 * (row_num, source_markdown_slug) and the partial UNIQUE index. The
 * orchestrator's job is the data half: walk every existing pre-v51 row
 * in the facts table (row_num IS NULL = "no fence yet") and append it
 * to its entity page's `## Facts` fence, atomically + idempotently.
 *
 * Phases:
 *   A. Schema       — assert migration v51 has run.
 *   B. Fence facts  — backfill DB facts → entity-page fences (dry-run
 *                     by default; explicit --write required).
 *   C. Verify       — re-parse each touched page, count rows, compare
 *                     against the DB rows for that page; partial on
 *                     mismatch.
 *   D. Record       — runner-owned ledger write (apply-migrations.ts).
 *
 * Idempotency: phase B only touches rows with row_num IS NULL. Re-runs
 * after a partial completion pick up where the previous run stopped.
 * Per-page atomic (.tmp + parse + rename, same primitive as
 * fence-write.ts). Dirty-tree refusal mirrors src/core/dry-fix.ts so
 * the user can review the diff before committing.
 *
 * Facts with NULL entity_slug are structurally unfenceable (no page to
 * fence onto). They're skipped with a warning; the operator decides
 * whether to hand-curate or delete them. Their row_num stays NULL
 * forever; they live in the legacy keyspace permanently.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { upsertFactRow, parseFactsFence } from '../../core/facts-fence.ts';
import { isWriteTargetContained } from '../../core/path-confine.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

async function getEngine(): Promise<BrainEngine | null> {
  if (testEngineOverride) return testEngineOverride;
  try {
    const cfg = loadConfig();
    if (!cfg) return null;
    const engineConfig = toEngineConfig(cfg);
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    return engine;
  } catch {
    return null;
  }
}

// ── Phase A — Schema verify ────────────────────────────────

async function phaseASchema(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  if (!engine) {
    return { name: 'schema', status: 'skipped', detail: 'no_brain_configured' };
  }
  try {
    const versionStr = await engine.getConfig('version');
    const v = parseInt(versionStr || '0', 10);
    if (v < 51) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected schema version >= 51 (facts_fence_columns); got ${v}. Run \`gbrain apply-migrations --yes\` to apply.`,
      };
    }
    // Quick post-condition: row_num + source_markdown_slug exist on facts.
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name IN ('row_num', 'source_markdown_slug')`,
    );
    if (rows.length < 2) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected columns row_num + source_markdown_slug on facts; found ${rows.map(r => r.column_name).join(', ') || 'none'}`,
      };
    }
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase B — Fence facts ──────────────────────────────────

interface LegacyFactRow {
  id: string;        // BIGSERIAL — string-typed on the wire for safety
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: 'event' | 'preference' | 'commitment' | 'belief' | 'fact';
  visibility: 'private' | 'world';
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date;
  valid_until: Date | null;
  source: string;
  confidence: number;
}

interface SourceLookup {
  id: string;
  local_path: string | null;
}

export interface MigrationTargetManifestEntry {
  source_id: string;
  original_entity_slug: string;
  target_markdown_slug: string;
  fact_ids: string[];
  fact_count: number;
  target_existed: boolean;
  disposition: 'existing' | 'quarantine';
  reason: 'existing_target' | 'missing_target' | 'unsafe_target';
}

export interface MigrationTargetManifest {
  version: '0.32.2';
  legacy_rows: number;
  unfenceable_rows: number;
  skipped_no_local_path_rows: number;
  target_count: number;
  would_create_count: number;
  quarantine_count: number;
  targets: MigrationTargetManifestEntry[];
}

interface PlannedTarget {
  sourceId: string;
  originalEntitySlug: string;
  targetMarkdownSlug: string;
  localPath: string;
  filePath: string;
  rows: LegacyFactRow[];
  targetExisted: boolean;
  disposition: 'existing' | 'quarantine';
  reason: 'existing_target' | 'missing_target' | 'unsafe_target';
}

interface PhaseBOutcome {
  scanned: number;
  fenced: number;
  skipped_no_entity: number;
  skipped_no_local_path: number;
  pages_touched: number;
  failed_pages: string[];
}

/**
 * Return true only when one of this migration's exact destination paths is
 * dirty. Unrelated source-repository changes are deliberately ignored.
 */
function areTargetPathsDirty(localPath: string, targetMarkdownSlugs: string[]): boolean {
  if (targetMarkdownSlugs.length === 0) return false;
  try {
    const targetPaths = targetMarkdownSlugs.map(slug => `${slug}.md`);
    const out = execFileSync('git', [
      '-C', localPath, 'status', '--porcelain', '--', ...targetPaths,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch {
    // Not a git repo OR git not on PATH → treat as "not dirty" (the
    // user opted out of git tracking, which is allowed). The fence
    // writes are still atomic via .tmp + rename.
    return false;
  }
}

function isSafeExistingTarget(localPath: string, entitySlug: string): boolean {
  if (!entitySlug || entitySlug.includes('\\') || entitySlug.includes('\0')) return false;
  const segments = entitySlug.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false;
  const candidate = resolve(join(localPath, `${entitySlug}.md`));
  if (!isWriteTargetContained(candidate, localPath)) return false;
  try {
    const stat = lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open an existing migration target without following a symbolic link.
 * Re-checking at open time closes the plan/read race for symlink swaps.
 */
function readRegularFileNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`migration target is not a regular file: ${path}`);
    }
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

function quarantineSlug(sourceId: string, entitySlug: string): string {
  const digest = createHash('sha256')
    .update(`${sourceId}\0${entitySlug}`)
    .digest('hex')
    .slice(0, 16);
  return `quarantine/migrations/v0-32-2/${digest}`;
}

async function buildTargetPlan(
  engine: BrainEngine,
): Promise<{ plan: PlannedTarget[]; manifest: MigrationTargetManifest }> {
  const sources = await engine.executeRaw<SourceLookup>(
    `SELECT id, local_path FROM sources`,
  );
  const localPathById = new Map<string, string | null>();
  for (const source of sources) localPathById.set(source.id, source.local_path);

  const legacy = await engine.executeRaw<LegacyFactRow>(
    `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
            context, valid_from, valid_until, source, confidence
       FROM facts
      WHERE row_num IS NULL
      ORDER BY source_id, entity_slug, id`,
  );

  let unfenceableRows = 0;
  let skippedNoLocalPathRows = 0;
  const grouped = new Map<string, LegacyFactRow[]>();
  for (const row of legacy) {
    if (row.entity_slug === null) {
      unfenceableRows += 1;
      continue;
    }
    const localPath = localPathById.get(row.source_id);
    if (!localPath) {
      skippedNoLocalPathRows += 1;
      continue;
    }
    const key = `${row.source_id}\0${row.entity_slug}`;
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }

  const plan: PlannedTarget[] = [];
  for (const [key, rows] of grouped) {
    const [sourceId, originalEntitySlug] = key.split('\0');
    const localPath = localPathById.get(sourceId)!;
    const safeExisting = isSafeExistingTarget(localPath, originalEntitySlug);
    const originalCandidate = resolve(join(localPath, `${originalEntitySlug}.md`));
    const unsafeTarget =
      !isWriteTargetContained(originalCandidate, localPath) ||
      (pathEntryExists(originalCandidate) && !safeExisting);
    const targetMarkdownSlug = safeExisting
      ? originalEntitySlug
      : quarantineSlug(sourceId, originalEntitySlug);
    const filePath = join(localPath, `${targetMarkdownSlug}.md`);
    if (!isWriteTargetContained(filePath, localPath)) {
      throw new Error(
        `migration quarantine target escapes source root: ${targetMarkdownSlug}`,
      );
    }
    plan.push({
      sourceId,
      originalEntitySlug,
      targetMarkdownSlug,
      localPath,
      filePath,
      rows,
      targetExisted: existsSync(filePath),
      disposition: safeExisting ? 'existing' : 'quarantine',
      reason: safeExisting ? 'existing_target' : unsafeTarget ? 'unsafe_target' : 'missing_target',
    });
  }
  plan.sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId) ||
    a.originalEntitySlug.localeCompare(b.originalEntitySlug));

  const targets: MigrationTargetManifestEntry[] = plan.map(target => ({
    source_id: target.sourceId,
    original_entity_slug: target.originalEntitySlug,
    target_markdown_slug: target.targetMarkdownSlug,
    fact_ids: target.rows.map(row => String(row.id)),
    fact_count: target.rows.length,
    target_existed: target.targetExisted,
    disposition: target.disposition,
    reason: target.reason,
  }));

  return {
    plan,
    manifest: {
      version: '0.32.2',
      legacy_rows: legacy.length,
      unfenceable_rows: unfenceableRows,
      skipped_no_local_path_rows: skippedNoLocalPathRows,
      target_count: targets.length,
      would_create_count: targets.filter(target => !target.target_existed).length,
      quarantine_count: targets.filter(target => target.disposition === 'quarantine').length,
      targets,
    },
  };
}

async function phaseBFenceFacts(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) {
    // Dry-run: report what WOULD happen without touching FS or DB.
    if (!engine) return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
    try {
      const { manifest } = await buildTargetPlan(engine);
      return {
        name: 'fence_facts',
        status: 'skipped',
        detail:
          `dry-run: legacy_rows=${manifest.legacy_rows} ` +
          `would_fence=${manifest.legacy_rows - manifest.unfenceable_rows - manifest.skipped_no_local_path_rows} ` +
          `targets=${manifest.target_count} would_create=${manifest.would_create_count} ` +
          `quarantine=${manifest.quarantine_count} unfenceable=${manifest.unfenceable_rows} ` +
          `skipped_no_local_path=${manifest.skipped_no_local_path_rows}`,
      };
    } catch (e) {
      return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  if (!engine) {
    return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
  }

  try {
    const { plan, manifest } = await buildTargetPlan(engine);

    // Dirty-tree refusal is scoped to this migration's exact destinations.
    const targetsBySource = new Map<string, { localPath: string; slugs: string[] }>();
    for (const target of plan) {
      const entry = targetsBySource.get(target.sourceId) ?? {
        localPath: target.localPath,
        slugs: [],
      };
      entry.slugs.push(target.targetMarkdownSlug);
      targetsBySource.set(target.sourceId, entry);
    }
    for (const [id, targetSet] of targetsBySource) {
      if (areTargetPathsDirty(targetSet.localPath, targetSet.slugs)) {
        return {
          name: 'fence_facts',
          status: 'failed',
          detail: `source "${id}" has uncommitted changes in a migration destination. Commit or stash the target path, then re-run.`,
        };
      }
    }

    const outcome: PhaseBOutcome = {
      scanned: manifest.legacy_rows,
      fenced: 0,
      skipped_no_entity: manifest.unfenceable_rows,
      skipped_no_local_path: manifest.skipped_no_local_path_rows,
      pages_touched: 0,
      failed_pages: [],
    };

    for (const target of plan) {
      const {
        targetMarkdownSlug, originalEntitySlug, filePath, rows: group,
      } = target;
      const tmpPath = `${filePath}.tmp`;

      try {
        // Re-check immediately before access so a pre-existing intermediate
        // symlink cannot redirect either the canonical or quarantine write.
        if (
          !isWriteTargetContained(filePath, target.localPath) ||
          !isWriteTargetContained(tmpPath, target.localPath)
        ) {
          throw new Error('migration target escapes source root');
        }

        // Read existing body or stub-create with minimum frontmatter.
        let body: string;
        if (existsSync(filePath)) {
          body = readRegularFileNoFollow(filePath);
        } else {
          mkdirSync(dirname(filePath), { recursive: true });
          const prefix = targetMarkdownSlug.split('/')[0];
          const type =
            prefix === 'people'    ? 'person' :
            prefix === 'companies' ? 'company' :
            prefix === 'deals'     ? 'deal' :
            /* fallback */           'concept';
          const title = target.disposition === 'quarantine'
            ? `Quarantined Legacy Facts ${targetMarkdownSlug.split('/').at(-1)}`
            : targetMarkdownSlug.split('/').slice(1).join('/')
                .replace(/[-_/]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ||
              targetMarkdownSlug;
          body = `---\ntype: ${type}\ntitle: ${title}\nslug: ${targetMarkdownSlug}\nvisibility: private\n---\n\n# ${title}\n`;
        }

        // Append each legacy row, collecting the assigned row_nums.
        // Already-fenced rows (row_num already set) are skipped at the
        // DB-row level by the WHERE clause, but if the SAME (entity,
        // source, claim, source-text) tuple was previously appended in
        // a partial-completion re-run, parseFactsFence will see the
        // existing row and append a duplicate. We dedup on (claim,
        // source) before append to handle this.
        const existingFence = parseFactsFence(body);
        const existingKeySet = new Set(existingFence.facts.map(f => `${f.claim}\0${f.source ?? ''}`));

        const assignments: Array<{ id: string; row_num: number }> = [];
        for (const row of group) {
          const key = `${row.fact}\0${row.source ?? ''}`;
          if (existingKeySet.has(key)) {
            // Already fenced (idempotent re-run). Find the existing
            // row_num and assign it to this DB row.
            const existing = existingFence.facts.find(f =>
              f.claim === row.fact && (f.source ?? '') === (row.source ?? ''),
            );
            if (existing) {
              assignments.push({ id: row.id, row_num: existing.rowNum });
              continue;
            }
          }
          // Append a new row.
          const validFromStr = (row.valid_from instanceof Date ? row.valid_from : new Date(row.valid_from))
            .toISOString().slice(0, 10);
          const validUntilStr = row.valid_until
            ? (row.valid_until instanceof Date ? row.valid_until : new Date(row.valid_until))
                .toISOString().slice(0, 10)
            : undefined;
          const { body: updated, rowNum } = upsertFactRow(body, {
            claim:      row.fact,
            kind:       row.kind,
            confidence: row.confidence,
            visibility: row.visibility,
            notability: row.notability,
            validFrom:  validFromStr,
            validUntil: validUntilStr,
            source:     row.source,
            context:    row.context ?? undefined,
          });
          body = updated;
          existingKeySet.add(key);
          assignments.push({ id: row.id, row_num: rowNum });
        }

        // Atomic write: .tmp + parse + rename.
        writeFileSync(tmpPath, body, 'utf-8');
        const tmpBody = readFileSync(tmpPath, 'utf-8');
        const parsed = parseFactsFence(tmpBody);
        if (parsed.warnings.length > 0) {
          outcome.failed_pages.push(`${targetMarkdownSlug} (${parsed.warnings.join('; ')})`);
          // .tmp stays for inspection; do NOT rename.
          continue;
        }
        renameSync(tmpPath, filePath);

        // UPDATE the DB rows with their new row_nums + source_markdown_slug.
        for (const a of assignments) {
          await engine.executeRaw(
            `UPDATE facts SET row_num = $1, source_markdown_slug = $2 WHERE id = $3`,
            [a.row_num, targetMarkdownSlug, a.id],
          );
        }
        outcome.fenced += assignments.length;
        outcome.pages_touched += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome.failed_pages.push(`${targetMarkdownSlug} [from ${originalEntitySlug}] (${msg})`);
      }
    }

    const detail = `scanned=${outcome.scanned} fenced=${outcome.fenced} ` +
      `pages=${outcome.pages_touched} skipped_no_entity=${outcome.skipped_no_entity} ` +
      `skipped_no_local_path=${outcome.skipped_no_local_path}` +
      (outcome.failed_pages.length > 0 ? ` failed=${outcome.failed_pages.length}` : '');

    if (outcome.failed_pages.length > 0) {
      return {
        name: 'fence_facts',
        status: 'failed',
        detail: `${detail} :: ${outcome.failed_pages.slice(0, 3).join(' | ')}${outcome.failed_pages.length > 3 ? '...' : ''}`,
      };
    }
    return { name: 'fence_facts', status: 'complete', detail };
  } catch (e) {
    return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase C — Verify ────────────────────────────────────────

async function phaseCVerify(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  if (!engine) return { name: 'verify', status: 'skipped', detail: 'no_brain_configured' };

  try {
    // Per touched page (= any page with a fenced row in the DB), re-parse
    // the fence from disk and compare row counts to the DB.
    const sources = await engine.executeRaw<SourceLookup>(
      `SELECT id, local_path FROM sources`,
    );
    const localPathById = new Map<string, string | null>();
    for (const s of sources) localPathById.set(s.id, s.local_path);

    const groups = await engine.executeRaw<{ source_id: string; source_markdown_slug: string; n: string }>(
      `SELECT source_id, source_markdown_slug, COUNT(*) AS n
         FROM facts
        WHERE row_num IS NOT NULL
        GROUP BY source_id, source_markdown_slug`,
    );

    const mismatches: string[] = [];
    let pagesChecked = 0;

    for (const g of groups) {
      const localPath = localPathById.get(g.source_id);
      if (!localPath) continue;
      const filePath = join(localPath, `${g.source_markdown_slug}.md`);
      if (!isWriteTargetContained(filePath, localPath) || !existsSync(filePath)) {
        mismatches.push(`${g.source_markdown_slug} (file missing)`);
        continue;
      }
      const body = readRegularFileNoFollow(filePath);
      const parsed = parseFactsFence(body);
      const fenceCount = parsed.facts.length;
      const dbCount = parseInt(g.n, 10);
      if (fenceCount !== dbCount) {
        mismatches.push(`${g.source_markdown_slug} (fence=${fenceCount}, db=${dbCount})`);
      }
      pagesChecked += 1;
    }

    if (mismatches.length > 0) {
      return {
        name: 'verify',
        status: 'failed',
        detail: `${mismatches.length} pages drifted: ${mismatches.slice(0, 3).join(' | ')}${mismatches.length > 3 ? '...' : ''}`,
      };
    }
    return { name: 'verify', status: 'complete', detail: `pages_checked=${pagesChecked}` };
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.32.2 — facts join the system-of-record invariant ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const engine = await getEngine();
  const phases: OrchestratorPhaseResult[] = [];

  const a = await phaseASchema(engine, opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const b = await phaseBFenceFacts(engine, opts);
  phases.push(b);
  if (b.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const c = await phaseCVerify(engine, opts);
  phases.push(c);

  const overallStatus: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' ? 'partial' : 'complete';

  return finalizeResult(phases, overallStatus, engine);
}

function finalizeResult(
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
  engine: BrainEngine | null,
): OrchestratorResult {
  // Best-effort disconnect of the engine we created. testEngineOverride
  // is owned by the test, never disconnected here.
  if (engine && !testEngineOverride) {
    engine.disconnect().catch(() => { /* best-effort */ });
  }
  return {
    version: '0.32.2',
    status,
    phases,
  };
}

export const v0_32_2: Migration = {
  version: '0.32.2',
  featurePitch: {
    headline: 'Facts join the system-of-record — your hot memory now lives in markdown, indexed by the DB',
    description:
      'v0.31 added hot-memory facts but they lived only in the database. v0.32.2 makes the ' +
      'fenced `## Facts` table on each entity page canonical: every new fact writes to markdown ' +
      'first, then stamps the DB index. Existing v0.31 facts are backfilled to fences on this ' +
      'migration. `gbrain rebuild` (v0.32.3) becomes a one-line disaster-recovery flow because ' +
      'the DB is now fully derivable from the repo. Migration is dry-run by default; pass ' +
      '`--write` to apply.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBFenceFacts,
  phaseCVerify,
  buildTargetPlan,
  areTargetPathsDirty,
  quarantineSlug,
};
