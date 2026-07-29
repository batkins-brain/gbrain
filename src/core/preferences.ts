/**
 * ~/.gbrain/preferences.json — user-facing agent-behavior flags (minion_mode, etc.).
 *
 * Separate from src/core/config.ts (engine config), written to its own file so
 * engine config and agent preferences can evolve independently. Atomic writes
 * via mktemp + rename; 0o600 perms; forward-compatible (preserves unknown keys).
 *
 * Also houses ~/.gbrain/migrations/completed.jsonl append helper.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync, mkdtempSync, rmSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { configDir } from './config.ts';

export type MinionMode = 'always' | 'pain_triggered' | 'off';

export interface Preferences {
  minion_mode?: MinionMode;
  set_at?: string;
  set_in_version?: string;
  [key: string]: unknown;
}

export interface CompletedMigrationEntry {
  version: string;
  ts?: string;
  /**
   * - `complete`  — orchestrator finished cleanly. Terminal state; future
   *   runs no-op this version unless `retry` is appended.
   * - `partial`   — orchestrator ran but reported missed phases; re-run is
   *   expected. Attempt cap (3 consecutive partials without a `complete`
   *   or `retry` between them) triggers the "wedged" skip in the runner.
   * - `retry`     — explicit reset marker written by `--force-retry`.
   *   Clears a wedge without faking success; the next upgrade treats the
   *   version as fresh again.
   */
  status: 'complete' | 'partial' | 'retry';
  mode?: MinionMode;
  files_rewritten?: number;
  autopilot_installed?: boolean;
  install_target?: string;
  apply_migrations_pending?: boolean;
  phases?: Array<{ name: string; status: string; detail?: string }>;
  [key: string]: unknown;
}

const VALID_MODES: ReadonlyArray<MinionMode> = ['always', 'pain_triggered', 'off'];

// Keep preferences and the migration ledger on the same path contract as
// engine config: GBRAIN_HOME is a parent directory and configDir() appends
// `.gbrain`. The former local helper treated GBRAIN_HOME as the .gbrain
// directory itself, splitting config and ledger state across two locations.
function prefsDir(): string { return configDir(); }
function prefsPath(): string { return join(prefsDir(), 'preferences.json'); }
function migrationsDir(): string { return join(configDir(), 'migrations'); }
function completedJsonlPath(): string { return join(migrationsDir(), 'completed.jsonl'); }
function legacyOverrideDir(): string | null {
  // Releases that predate the configDir() alignment treated GBRAIN_HOME as
  // the .gbrain directory itself. When the override is set, keep a read-only
  // compatibility lane so preferences and terminal migration history are not
  // silently abandoned. Calling configDir() first validates the override.
  const canonical = configDir();
  const raw = process.env.GBRAIN_HOME?.trim();
  if (!raw || raw === canonical) return null;
  return raw;
}
function legacyPrefsPath(): string | null {
  const dir = legacyOverrideDir();
  return dir ? join(dir, 'preferences.json') : null;
}
function legacyCompletedJsonlPath(): string | null {
  const dir = legacyOverrideDir();
  return dir ? join(dir, 'migrations', 'completed.jsonl') : null;
}

/** Validate that a value is a recognized minion mode. Throws with the allowed list. */
export function validateMinionMode(value: unknown): asserts value is MinionMode {
  if (typeof value !== 'string' || !VALID_MODES.includes(value as MinionMode)) {
    throw new Error(`Invalid minion_mode "${String(value)}". Allowed: ${VALID_MODES.join(', ')}.`);
  }
}

/**
 * Load preferences. Returns {} when the file is missing (not null — callers
 * can always treat the result as a Preferences object).
 *
 * Malformed JSON throws; caller can catch if they want graceful fallback.
 */
export function loadPreferences(): Preferences {
  const canonical = prefsPath();
  const legacy = legacyPrefsPath();
  // Canonical state always wins. The legacy path is a read-only fallback;
  // the next explicit save writes canonically with restrictive permissions.
  const path = existsSync(canonical)
    ? canonical
    : legacy && existsSync(legacy)
      ? legacy
      : canonical;
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Preferences;
  return parsed;
}

/**
 * Save preferences atomically (mktemp on same filesystem + rename). Preserves
 * any unknown keys passed in. Chmods 0o600 after write.
 */
export function savePreferences(prefs: Preferences): void {
  if (prefs.minion_mode !== undefined) validateMinionMode(prefs.minion_mode);

  const dir = prefsDir();
  mkdirSync(dir, { recursive: true });

  // Write via a tempfile on the same filesystem, then rename. Avoids the
  // "reader sees a half-written file" window that write-in-place has.
  const tmpDirForWrite = mkdtempSync(join(dir, '.prefs-tmp-'));
  const tmpPath = join(tmpDirForWrite, 'preferences.json');
  try {
    writeFileSync(tmpPath, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(tmpPath, 0o600); } catch { /* chmod may fail on some platforms */ }
    renameSync(tmpPath, prefsPath());
  } finally {
    try { rmSync(tmpDirForWrite, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  try { chmodSync(prefsPath(), 0o600); } catch { /* best-effort */ }
}

/**
 * Append one line to ~/.gbrain/migrations/completed.jsonl. Creates the
 * directory if missing. Does not read existing lines (append is cheap and
 * the reader tolerates malformed lines by skipping them).
 *
 * Writes `ts` as the current ISO timestamp if not provided.
 */
export function appendCompletedMigration(entry: CompletedMigrationEntry): void {
  if (!entry.version) throw new Error('appendCompletedMigration: version required');
  if (entry.status !== 'complete' && entry.status !== 'partial' && entry.status !== 'retry') {
    throw new Error(`appendCompletedMigration: status must be 'complete', 'partial', or 'retry', got "${entry.status}"`);
  }
  // Bug 3 — idempotency guard. If the most recent existing entry for this
  // version is already 'complete' and we're about to write another
  // 'complete', skip. This protects against accidental double-writes
  // during the Bug 3 runner-owned-ledger transition (old orchestrator
  // code paths and new runner path shouldn't both write).
  if (entry.status === 'complete') {
    const existing = loadCompletedMigrations();
    const prior = existing.filter(e => e.version === entry.version);
    if (prior.length > 0 && prior[prior.length - 1].status === 'complete') {
      return; // no-op — already terminal
    }
  }
  const full: CompletedMigrationEntry = {
    ts: new Date().toISOString(),
    ...entry,
  };
  const dir = migrationsDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(completedJsonlPath(), JSON.stringify(full) + '\n', { mode: 0o600 });
  try { chmodSync(completedJsonlPath(), 0o600); } catch { /* best-effort */ }
}

function readCompletedMigrations(path: string): CompletedMigrationEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const out: CompletedMigrationEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as CompletedMigrationEntry);
    } catch (err) {
      console.warn(`[preferences] skipping malformed completed.jsonl line: ${trimmed.slice(0, 120)}`);
    }
  }
  return out;
}

/**
 * Read canonical and legacy migration ledgers. Canonical entries are appended
 * after legacy entries so their newer ordering wins, while any legacy
 * terminal completion remains visible to the runner. Exact overlap between
 * the two files is removed one-for-one without collapsing repeated entries
 * within either ledger: repeated partials are distinct migration attempts,
 * even when their timestamps happen to be identical.
 */
export function loadCompletedMigrations(): CompletedMigrationEntry[] {
  const legacy = legacyCompletedJsonlPath();
  const legacyEntries = legacy ? readCompletedMigrations(legacy) : [];
  const canonicalEntries = readCompletedMigrations(completedJsonlPath());
  const overlappingLegacyCounts = new Map<string, number>();
  for (const entry of legacyEntries) {
    const key = JSON.stringify(entry);
    overlappingLegacyCounts.set(key, (overlappingLegacyCounts.get(key) ?? 0) + 1);
  }

  const merged = [...legacyEntries];
  for (const entry of canonicalEntries) {
    const key = JSON.stringify(entry);
    const remainingOverlap = overlappingLegacyCounts.get(key) ?? 0;
    if (remainingOverlap > 0) {
      overlappingLegacyCounts.set(key, remainingOverlap - 1);
      continue;
    }
    merged.push(entry);
  }
  return merged;
}

/** Paths — exported for tests and rare consumers. */
export const preferencesPaths = {
  dir: prefsDir,
  file: prefsPath,
  migrationsDir,
  completedJsonl: completedJsonlPath,
  legacyFile: legacyPrefsPath,
  legacyCompletedJsonl: legacyCompletedJsonlPath,
};
