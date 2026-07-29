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
 *   B. Fence facts  — backfill DB facts → entity-page fences. The runner's
 *                     explicit --dry-run mode plans without writing.
 *   C. Verify       — re-parse each touched page, count rows, compare
 *                     against the DB rows for that page; partial on
 *                     mismatch.
 *   D. Record       — runner-owned ledger write (apply-migrations.ts).
 *
 * Idempotency: phase B only touches rows with row_num IS NULL. Re-runs
 * after a partial completion pick up where the previous run stopped.
 * Per-page atomic (.tmp + parse + descriptor-anchored publish). Dirty-tree
 * refusal is scoped to the exact migration destinations so unrelated edits
 * remain untouched.
 *
 * Facts with NULL entity_slug are structurally unfenceable (no page to
 * fence onto). They're skipped with a warning; the operator decides
 * whether to hand-curate or delete them. Their row_num stays NULL
 * forever; they live in the legacy keyspace permanently.
 */

import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { upsertFactRow, parseFactsFence } from '../../core/facts-fence.ts';
import { isWriteTargetContained } from '../../core/path-confine.ts';
import { withPageLock } from '../../core/page-lock.ts';

let testEngineOverride: BrainEngine | null = null;
let testPageLockRoot: string | undefined;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}
export function __setTestPageLockRoot(lockRoot: string | undefined): void {
  testPageLockRoot = lockRoot;
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
  claim_metric: string | null;
  claim_value: number | null;
  claim_unit: string | null;
  claim_period: string | null;
}

interface FencedFactRow extends LegacyFactRow {
  row_num: number;
  source_markdown_slug: string;
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
  tmpPath: string;
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

interface MigrationTargetPhaseResult extends OrchestratorPhaseResult {
  /** Operator-visible, deterministic mapping; never written to the ledger. */
  manifest?: MigrationTargetManifest;
}

export interface MigrationTargetOrchestratorResult extends OrchestratorResult {
  /** Available from the public dry-run/orchestrator result contract. */
  target_manifest?: MigrationTargetManifest;
}

/**
 * Return true only when one of this migration's exact destination paths is
 * dirty. Unrelated source-repository changes are deliberately ignored.
 */
function areTargetPathsDirty(
  localPath: string,
  targetMarkdownSlugs: string[],
  additionalRelativePaths: string[] = [],
): boolean {
  if (targetMarkdownSlugs.length === 0 && additionalRelativePaths.length === 0) return false;
  const targetPaths = [
    ...targetMarkdownSlugs.map(slug => `${slug}.md`),
    ...additionalRelativePaths,
  ];
  // Distinguish a proven non-repository from an operational error. A missing
  // git binary, timeout, permission problem, or corrupt repository must not
  // silently authorize writes to migration destinations.
  const probe = spawnSync(
    'git',
    ['-C', localPath, 'rev-parse', '--is-inside-work-tree'],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );
  if (probe.error) {
    throw new Error(`could not inspect migration source Git state: ${probe.error.message}`);
  }
  if (probe.status !== 0) {
    const diagnostic = `${probe.stderr ?? ''}\n${probe.stdout ?? ''}`.trim();
    if (/not a git repository/i.test(diagnostic)) return false;
    throw new Error(
      `could not prove migration source Git state${diagnostic ? `: ${diagnostic}` : ''}`,
    );
  }
  if (probe.stdout.trim() !== 'true') {
    throw new Error('could not prove migration source is inside a Git worktree');
  }
  try {
    const out = execFileSync('git', [
      '--literal-pathspecs', '-C', localPath,
      'status', '--porcelain', '--', ...targetPaths,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch (error) {
    throw new Error(
      `could not inspect migration destination Git state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Reject every symbolic link below the registered source root, even when it
 * resolves to another location inside that root. Missing tail components are
 * allowed for new quarantine pages; only existing components are inspected.
 */
function hasNoSymlinkComponents(target: string, localPath: string): boolean {
  const root = resolve(localPath);
  const absoluteTarget = resolve(target);
  const rel = relative(root, absoluteTarget);
  if (rel === '') return true;
  if (rel.startsWith('..') || isAbsolute(rel)) return false;

  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch {
      break;
    }
  }
  return true;
}

function isSafeExistingTarget(localPath: string, entitySlug: string): boolean {
  if (!entitySlug || entitySlug.includes('\\') || entitySlug.includes('\0')) return false;
  const segments = entitySlug.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false;
  const candidate = resolve(join(localPath, `${entitySlug}.md`));
  if (
    !isWriteTargetContained(candidate, localPath) ||
    !hasNoSymlinkComponents(candidate, localPath)
  ) return false;
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
 * Linux and Darwin expose open directory descriptors below /proc/self/fd or
 * /dev/fd. Walking from an already-open source-root descriptor makes every
 * subsequent lookup relative to a stable directory object, so swapping an
 * intermediate path component cannot redirect a read or write outside the
 * registered source.
 *
 * This migration handles private facts. Platforms without descriptor-relative
 * paths fail closed instead of falling back to race-prone pathname I/O.
 */
interface AnchoredParent {
  fd: number;
  procPath: string;
  absolutePath: string;
  localPath: string;
  canonicalRoot: string;
  dev: number;
  ino: number;
}

function descriptorFdPath(base: string, fd: number): string {
  return `${base}/${fd}`;
}

function assertDirectoryFd(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isDirectory()) throw new Error('migration path component is not a directory');
}

function descriptorBaseForFd(fd: number): string {
  const expected = fstatSync(fd);
  for (const base of ['/proc/self/fd', '/dev/fd']) {
    if (!pathEntryExists(base)) continue;
    let probeFd: number | undefined;
    try {
      probeFd = openSync(
        `${descriptorFdPath(base, fd)}/.`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const actual = fstatSync(probeFd);
      if (actual.dev === expected.dev && actual.ino === expected.ino) return base;
    } catch {
      // Try the next platform descriptor filesystem.
    } finally {
      if (probeFd !== undefined) closeSync(probeFd);
    }
  }
  throw new Error(
    'migration requires descriptor-relative directory I/O (/proc/self/fd or /dev/fd)',
  );
}

function openAnchoredParent(
  localPath: string,
  targetPath: string,
  createMissing: boolean,
): AnchoredParent {
  const absoluteRoot = resolve(localPath);
  const absoluteTarget = resolve(targetPath);
  const rel = relative(absoluteRoot, absoluteTarget);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`migration target escapes source root: ${targetPath}`);
  }
  const segments = rel.split(sep);
  const directorySegments = segments.slice(0, -1);
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`migration target has an unsafe path component: ${targetPath}`);
  }
  const canonicalRoot = realpathSync(absoluteRoot);
  const canonicalSegments = canonicalRoot.split(sep).filter(Boolean);
  let fd = openSync(
    sep,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    assertDirectoryFd(fd);
    const descriptorBase = descriptorBaseForFd(fd);
    for (const segment of canonicalSegments) {
      const childFd = openSync(
        join(descriptorFdPath(descriptorBase, fd), segment),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeSync(fd);
      fd = childFd;
      assertDirectoryFd(fd);
    }
    const openedRootPath = realpathSync(descriptorFdPath(descriptorBase, fd));
    if (openedRootPath !== canonicalRoot) {
      throw new Error('registered source root changed while opening');
    }
    const openedRootStat = fstatSync(fd);
    const effectiveUid = process.getuid?.();
    if (effectiveUid !== undefined && openedRootStat.uid !== effectiveUid) {
      throw new Error('registered source root is not owned by the effective user');
    }
    if ((openedRootStat.mode & 0o022) !== 0) {
      throw new Error('registered source root is group- or world-writable');
    }

    let currentAbsolute = canonicalRoot;
    for (const segment of directorySegments) {
      const child = join(descriptorFdPath(descriptorBase, fd), segment);
      let childFd: number;
      try {
        childFd = openSync(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!createMissing || code !== 'ENOENT') throw error;
        mkdirSync(child, { mode: 0o700 });
        childFd = openSync(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      }
      closeSync(fd);
      fd = childFd;
      currentAbsolute = join(currentAbsolute, segment);
      assertDirectoryFd(fd);
    }
    const stat = fstatSync(fd);
    return {
      fd,
      procPath: descriptorFdPath(descriptorBase, fd),
      absolutePath: currentAbsolute,
      localPath: absoluteRoot,
      canonicalRoot,
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function closeAnchoredParent(parent: AnchoredParent): void {
  closeSync(parent.fd);
}

function assertAnchoredParentStillCurrent(parent: AnchoredParent): void {
  const openedPath = realpathSync(parent.procPath);
  if (
    openedPath !== parent.absolutePath ||
    !isWriteTargetContained(openedPath, parent.canonicalRoot)
  ) {
    throw new Error('migration target directory moved outside its anchored source path');
  }
  if (!hasNoSymlinkComponents(parent.absolutePath, parent.localPath)) {
    throw new Error('migration target path changed: symbolic-link component detected');
  }
  const currentFd = openSync(
    parent.absolutePath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(currentFd);
    if (!stat.isDirectory() || stat.dev !== parent.dev || stat.ino !== parent.ino) {
      throw new Error('migration target path changed during descriptor-anchored write');
    }
  } finally {
    closeSync(currentFd);
  }
}

function anchoredChildPath(parent: AnchoredParent, name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`unsafe migration child name: ${name}`);
  }
  return join(parent.procPath, name);
}

function anchoredChildExists(parent: AnchoredParent, name: string): boolean {
  try {
    lstatSync(anchoredChildPath(parent, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function readRegularFileAt(parent: AnchoredParent, name: string): string {
  const path = anchoredChildPath(parent, name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`migration target is not a regular file: ${name}`);
    }
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

function writeOwnedTempFileAt(parent: AnchoredParent, name: string, body: string): void {
  const path = anchoredChildPath(parent, name);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`migration temporary target is not a regular file: ${path}`);
    }
    writeFileSync(fd, body, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

function migrationTargetFingerprint(sourceId: string, entitySlug: string): string {
  return createHash('sha256').update(`${sourceId}\0${entitySlug}`).digest('hex');
}

function quarantineSlug(sourceId: string, entitySlug: string): string {
  const digest = migrationTargetFingerprint(sourceId, entitySlug).slice(0, 16);
  return `quarantine/migrations/v0-32-2/${digest}`;
}

function frontmatterValues(body: string, key: string): string[] {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map(line => line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/))
    .filter((entry): entry is RegExpMatchArray => Boolean(entry))
    .filter(entry => entry[1] === key)
    .map(entry => entry[2]);
}

function assertOwnedQuarantineBody(body: string, target: PlannedTarget): void {
  const required = new Map<string, string>([
    ['gbrain_migration_owner', 'v0.32.2'],
    ['gbrain_migration_target_sha256',
      migrationTargetFingerprint(target.sourceId, target.originalEntitySlug)],
    ['slug', target.targetMarkdownSlug],
    ['visibility', 'private'],
  ]);
  for (const [key, expected] of required) {
    const values = frontmatterValues(body, key);
    if (values.length !== 1 || values[0] !== expected) {
      throw new Error(
        `quarantine destination is not owned by migration v0.32.2 (${key})`,
      );
    }
  }
}

function dateOnly(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function normalizedConfidence(value: number): number {
  return Number.parseFloat(Number(value).toFixed(2));
}

function dbFactIdentity(row: LegacyFactRow): string {
  return JSON.stringify({
    claim: row.fact,
    kind: row.kind,
    confidence: normalizedConfidence(row.confidence),
    visibility: row.visibility,
    notability: row.notability,
    validFrom: dateOnly(row.valid_from),
    validUntil: dateOnly(row.valid_until),
    source: row.source ?? '',
    context: row.context ?? '',
    claimMetric: row.claim_metric ?? '',
    claimValue: row.claim_value ?? null,
    claimUnit: row.claim_unit ?? '',
    claimPeriod: row.claim_period ?? '',
  });
}

function fenceFactIdentity(row: ReturnType<typeof parseFactsFence>['facts'][number]): string {
  return JSON.stringify({
    claim: row.claim,
    kind: row.kind,
    confidence: normalizedConfidence(row.confidence),
    visibility: row.visibility,
    notability: row.notability,
    validFrom: row.validFrom ?? '',
    validUntil: row.validUntil ?? '',
    source: row.source ?? '',
    context: row.context ?? '',
    claimMetric: row.claimMetric ?? '',
    claimValue: row.claimValue ?? null,
    claimUnit: row.claimUnit ?? '',
    claimPeriod: row.claimPeriod ?? '',
  });
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
            context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period
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
      !hasNoSymlinkComponents(originalCandidate, localPath) ||
      (pathEntryExists(originalCandidate) && !safeExisting);
    const targetMarkdownSlug = safeExisting
      ? originalEntitySlug
      : quarantineSlug(sourceId, originalEntitySlug);
    const filePath = join(localPath, `${targetMarkdownSlug}.md`);
    const tmpPath = join(
      dirname(filePath),
      `.${targetMarkdownSlug.split('/').at(-1)}.migration-${process.pid}-${randomUUID()}.tmp`,
    );
    if (
      !isWriteTargetContained(filePath, localPath) ||
      !hasNoSymlinkComponents(filePath, localPath) ||
      !isWriteTargetContained(tmpPath, localPath) ||
      !hasNoSymlinkComponents(tmpPath, localPath)
    ) {
      throw new Error(
        `migration quarantine target escapes source root: ${targetMarkdownSlug}`,
      );
    }
    const target: PlannedTarget = {
      sourceId,
      originalEntitySlug,
      targetMarkdownSlug,
      localPath,
      filePath,
      tmpPath,
      rows,
      targetExisted: pathEntryExists(filePath),
      disposition: safeExisting ? 'existing' : 'quarantine',
      reason: safeExisting ? 'existing_target' : unsafeTarget ? 'unsafe_target' : 'missing_target',
    };
    if (target.disposition === 'quarantine' && target.targetExisted) {
      const parent = openAnchoredParent(localPath, filePath, false);
      try {
        assertOwnedQuarantineBody(
          readRegularFileAt(parent, basename(filePath)),
          target,
        );
      } finally {
        closeAnchoredParent(parent);
      }
    }
    plan.push(target);
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
): Promise<MigrationTargetPhaseResult> {
  if (opts.dryRun) {
    // Dry-run: report what WOULD happen without touching FS or DB.
    if (!engine) return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
    try {
      const { manifest } = await buildTargetPlan(engine);
      return {
        name: 'fence_facts',
        status: 'skipped',
        manifest,
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
    const targetsBySource = new Map<string, {
      localPath: string;
      slugs: string[];
      additionalRelativePaths: string[];
    }>();
    for (const target of plan) {
      const entry = targetsBySource.get(target.sourceId) ?? {
        localPath: target.localPath,
        slugs: [],
        additionalRelativePaths: [],
      };
      entry.slugs.push(target.targetMarkdownSlug);
      entry.additionalRelativePaths.push(relative(target.localPath, target.tmpPath));
      targetsBySource.set(target.sourceId, entry);
    }
    for (const [id, targetSet] of targetsBySource) {
      if (areTargetPathsDirty(
        targetSet.localPath,
        targetSet.slugs,
        targetSet.additionalRelativePaths,
      )) {
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
        targetMarkdownSlug, originalEntitySlug, filePath, tmpPath, rows: group,
      } = target;

      try {
        // Every supported gbrain markdown writer uses this exact per-page lock
        // key. Holding it across read, optimistic comparison, publication, and
        // DB stamping makes the comparison enforceable rather than advisory.
        await withPageLock(targetMarkdownSlug, async () => {
          // Re-check immediately before access so a pre-existing intermediate
          // symlink cannot redirect either the canonical or quarantine write.
          if (
            !isWriteTargetContained(filePath, target.localPath) ||
            !hasNoSymlinkComponents(filePath, target.localPath) ||
            !isWriteTargetContained(tmpPath, target.localPath) ||
            !hasNoSymlinkComponents(tmpPath, target.localPath)
          ) {
            throw new Error('migration target escapes source root');
          }

          const parent = openAnchoredParent(target.localPath, filePath, true);
          try {
          const fileName = basename(filePath);
          const tmpName = basename(tmpPath);
          const targetExistedAtOpen = anchoredChildExists(parent, fileName);

          // Read existing body or stub-create with minimum frontmatter.
          let body: string;
          if (targetExistedAtOpen) {
            body = readRegularFileAt(parent, fileName);
            if (target.disposition === 'quarantine') {
              assertOwnedQuarantineBody(body, target);
            }
          } else {
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
            const ownership = target.disposition === 'quarantine'
              ? `gbrain_migration_owner: v0.32.2\n` +
                `gbrain_migration_target_sha256: ${migrationTargetFingerprint(
                  target.sourceId,
                  target.originalEntitySlug,
                )}\n`
              : '';
            body =
              `---\ntype: ${type}\ntitle: ${title}\nslug: ${targetMarkdownSlug}\n` +
              `${ownership}visibility: private\n---\n\n# ${title}\n`;
          }
          const originalBody = targetExistedAtOpen ? body : null;

          const existingFence = parseFactsFence(body);
          if (existingFence.warnings.length > 0) {
            throw new Error(existingFence.warnings.join('; '));
          }

          // DB rows already stamped to this page own their row numbers. Validate
          // that the fence still carries the same full fact identity before
          // considering any unowned fence rows for crash recovery.
          const assignedRows = await engine.executeRaw<FencedFactRow>(
            `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
                    context, valid_from, valid_until, source, confidence,
                    claim_metric, claim_value, claim_unit, claim_period,
                    row_num, source_markdown_slug
               FROM facts
              WHERE source_id = $1
                AND source_markdown_slug = $2
                AND row_num IS NOT NULL
              ORDER BY row_num, id`,
            [target.sourceId, targetMarkdownSlug],
          );
          const fenceByRowNum = new Map(existingFence.facts.map(fact => [fact.rowNum, fact]));
          const occupiedRowNums = new Set<number>();
          for (const assigned of assignedRows) {
            const fenced = fenceByRowNum.get(Number(assigned.row_num));
            if (!fenced || fenceFactIdentity(fenced) !== dbFactIdentity(assigned)) {
              throw new Error(
                `existing DB/fence identity drift at row ${assigned.row_num}`,
              );
            }
            occupiedRowNums.add(Number(assigned.row_num));
          }

          // Recovery candidates are consumed one-for-one by full normalized
          // identity. Duplicate legacy facts therefore retain distinct rows,
          // while a crash after the file rename can safely reuse each orphaned
          // fence row at most once.
          const availableByIdentity = new Map<string, number[]>();
          for (const fact of existingFence.facts) {
            if (occupiedRowNums.has(fact.rowNum)) continue;
            const identity = fenceFactIdentity(fact);
            const queue = availableByIdentity.get(identity) ?? [];
            queue.push(fact.rowNum);
            availableByIdentity.set(identity, queue);
          }

          const assignments: Array<{ id: string; row_num: number }> = [];
          for (const row of group) {
            const identity = dbFactIdentity(row);
            const queue = availableByIdentity.get(identity);
            const recoveredRowNum = queue?.shift();
            if (recoveredRowNum !== undefined) {
              assignments.push({ id: row.id, row_num: recoveredRowNum });
              occupiedRowNums.add(recoveredRowNum);
              continue;
            }

            const { body: updated, rowNum } = upsertFactRow(body, {
              claim:      row.fact,
              kind:       row.kind,
              confidence: row.confidence,
              visibility: row.visibility,
              notability: row.notability,
              validFrom:  dateOnly(row.valid_from),
              validUntil: dateOnly(row.valid_until) || undefined,
              source:     row.source,
              context:    row.context ?? undefined,
              claimMetric: row.claim_metric ?? undefined,
              claimValue:  row.claim_value ?? undefined,
              claimUnit:   row.claim_unit ?? undefined,
              claimPeriod: row.claim_period ?? undefined,
            });
            body = updated;
            occupiedRowNums.add(rowNum);
            assignments.push({ id: row.id, row_num: rowNum });
          }

          // Parse in memory first: private bytes are not staged anywhere on
          // disk until the descriptor-anchored destination has passed its
          // placement and optimistic-content checks.
          const parsed = parseFactsFence(body);
          if (parsed.warnings.length > 0) {
            outcome.failed_pages.push(`${targetMarkdownSlug} (${parsed.warnings.join('; ')})`);
            return;
          }
          assertAnchoredParentStillCurrent(parent);
          if (targetExistedAtOpen) {
            const currentBody = readRegularFileAt(parent, fileName);
            if (currentBody !== originalBody) {
              throw new Error('migration destination changed during fence preparation');
            }
            if (target.disposition === 'quarantine') {
              assertOwnedQuarantineBody(currentBody, target);
              // Quarantine publication is append-never. A prior publication
              // may be reused for exact crash recovery, but never replaced
              // with different private content.
              if (body !== originalBody) {
                throw new Error(
                  'owned quarantine destination is immutable; refusing replacement',
                );
              }
            }
            if (body !== originalBody) {
              writeOwnedTempFileAt(parent, tmpName, body);
              assertAnchoredParentStillCurrent(parent);
              const compareBody = readRegularFileAt(parent, fileName);
              if (compareBody !== originalBody) {
                throw new Error('migration destination changed before publication');
              }
              renameSync(
                anchoredChildPath(parent, tmpName),
                anchoredChildPath(parent, fileName),
              );
            }
          } else {
            writeOwnedTempFileAt(parent, tmpName, body);
            assertAnchoredParentStillCurrent(parent);
            linkSync(
              anchoredChildPath(parent, tmpName),
              anchoredChildPath(parent, fileName),
            );
            unlinkSync(anchoredChildPath(parent, tmpName));
          }
          assertAnchoredParentStillCurrent(parent);

          // UPDATE the DB rows with their new row_nums + source_markdown_slug.
          for (const a of assignments) {
            await engine.executeRaw(
              `UPDATE facts SET row_num = $1, source_markdown_slug = $2 WHERE id = $3`,
              [a.row_num, targetMarkdownSlug, a.id],
            );
          }
          outcome.fenced += assignments.length;
          outcome.pages_touched += 1;
          } finally {
            closeAnchoredParent(parent);
          }
        }, testPageLockRoot ? { lockRoot: testPageLockRoot } : {});
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
    return { name: 'fence_facts', status: 'complete', detail, manifest };
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

    const rows = await engine.executeRaw<FencedFactRow>(
      `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
              context, valid_from, valid_until, source, confidence,
              claim_metric, claim_value, claim_unit, claim_period,
              row_num, source_markdown_slug
         FROM facts
        WHERE row_num IS NOT NULL
        ORDER BY source_id, source_markdown_slug, row_num, id`,
    );
    const groups = new Map<string, FencedFactRow[]>();
    for (const row of rows) {
      const key = `${row.source_id}\0${row.source_markdown_slug}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }

    const mismatches: string[] = [];
    let pagesChecked = 0;

    for (const [key, group] of groups) {
      const [sourceId, sourceMarkdownSlug] = key.split('\0');
      const localPath = localPathById.get(sourceId);
      if (!localPath) continue;
      const filePath = join(localPath, `${sourceMarkdownSlug}.md`);
      if (
        !isWriteTargetContained(filePath, localPath) ||
        !hasNoSymlinkComponents(filePath, localPath)
      ) {
        mismatches.push(`${sourceMarkdownSlug} (file missing or unsafe)`);
        continue;
      }
      try {
        const parent = openAnchoredParent(localPath, filePath, false);
        try {
          if (!anchoredChildExists(parent, basename(filePath))) {
            mismatches.push(`${sourceMarkdownSlug} (file missing)`);
            continue;
          }
          const body = readRegularFileAt(parent, basename(filePath));
          const parsed = parseFactsFence(body);
          if (parsed.warnings.length > 0) {
            mismatches.push(`${sourceMarkdownSlug} (${parsed.warnings.join('; ')})`);
            continue;
          }
          const fenceByRowNum = new Map(parsed.facts.map(fact => [fact.rowNum, fact]));
          if (parsed.facts.length !== group.length) {
            mismatches.push(
              `${sourceMarkdownSlug} (fence=${parsed.facts.length}, db=${group.length})`,
            );
            continue;
          }
          const drifted = group.find(row => {
            const fenced = fenceByRowNum.get(Number(row.row_num));
            return !fenced || fenceFactIdentity(fenced) !== dbFactIdentity(row);
          });
          if (drifted) {
            mismatches.push(`${sourceMarkdownSlug} (identity drift at row=${drifted.row_num})`);
          }
        } finally {
          closeAnchoredParent(parent);
        }
      } catch (error) {
        mismatches.push(
          `${sourceMarkdownSlug} (${error instanceof Error ? error.message : String(error)})`,
        );
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

async function orchestrator(opts: OrchestratorOpts): Promise<MigrationTargetOrchestratorResult> {
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
  if (b.status === 'failed') {
    return { ...finalizeResult(phases, 'failed', engine), target_manifest: b.manifest };
  }

  const c = await phaseCVerify(engine, opts);
  phases.push(c);

  const overallStatus: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' ? 'partial' : 'complete';

  return { ...finalizeResult(phases, overallStatus, engine), target_manifest: b.manifest };
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

export const v0_32_2: Omit<Migration, 'orchestrator'> & {
  orchestrator: (opts: OrchestratorOpts) => Promise<MigrationTargetOrchestratorResult>;
} = {
  version: '0.32.2',
  featurePitch: {
    headline: 'Facts join the system-of-record — your hot memory now lives in markdown, indexed by the DB',
    description:
      'v0.31 added hot-memory facts but they lived only in the database. v0.32.2 makes the ' +
      'fenced `## Facts` table on each entity page canonical: every new fact writes to markdown ' +
      'first, then stamps the DB index. Existing v0.31 facts are backfilled to fences on this ' +
      'migration. `gbrain rebuild` (v0.32.3) becomes a one-line disaster-recovery flow because ' +
      'the DB is now fully derivable from the repo. Use `gbrain apply-migrations --dry-run` ' +
      'to inspect the deterministic target manifest before applying.',
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
  migrationTargetFingerprint,
  openAnchoredParent,
  closeAnchoredParent,
  anchoredChildPath,
  assertAnchoredParentStillCurrent,
  readRegularFileAt,
  writeOwnedTempFileAt,
};
