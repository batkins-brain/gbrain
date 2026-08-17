/**
 * Floor guard for the full-sync reconcile-delete sweep.
 *
 * The sweep in `performFullSync` decides a page is stale by ABSENCE: it
 * enumerates the working tree, then deletes every file-backed page whose
 * `source_path` is not in that enumeration. Its existing safety conditions
 * pick WHICH pages are eligible (file-backed, syncable, absent). Nothing
 * bounded HOW MANY it may remove, so a directory read that returned nothing
 * was indistinguishable from "every file in this repo was deleted".
 *
 * On 2026-08-17 that emptied a production brain: 11,496 pages -> 34. The 34
 * survivors were exactly the pages with `source_path IS NULL`, which the sweep
 * structurally spares — the fingerprint of this code path, not of a truncate.
 *
 * Absence is weak evidence. A missing mount, a half-checked-out worktree, a
 * permissions blip, or a wrong `repoPath` all present as "no files here", and
 * the sweep's response to that was to delete the entire source. This module
 * makes the sweep refuse to act on evidence that weak, unless a human says so.
 *
 * Deliberately a pure function over counts: no engine, no filesystem, no I/O.
 * That keeps the dangerous decision testable without a database, which is how
 * the 2026-08-17 fingerprint above can be replayed as a unit test.
 *
 * NOTE ON SCOPE: the INCREMENTAL delete path is intentionally not guarded here.
 * It deletes what git's diff manifest reports as deleted — a positive
 * statement from a source of truth — rather than inferring deletion from an
 * empty read. Bounding that path would refuse legitimate large commits.
 */

/** Share of a source's file-backed pages that one sweep may delete unattended. */
export const RECONCILE_BULK_DELETE_RATIO = 0.5;

/**
 * Below this many file-backed pages, the ratio is too noisy to be a signal
 * (deleting 3 of 4 pages in a tiny source is ordinary). The empty-enumeration
 * rule still applies at any size.
 */
export const RECONCILE_RATIO_MIN_PAGES = 10;

export type ReconcileRefusal = 'empty_enumeration' | 'bulk_delete_ratio';

export interface ReconcileSweepInput {
  /** Files found on disk for this source by `collectSyncableFiles`. */
  enumeratedCount: number;
  /** Pages for this source with a non-null `source_path` (sweep-eligible). */
  fileBackedCount: number;
  /** Of those, how many the sweep classified stale and would delete. */
  staleCount: number;
}

export interface ReconcileSweepAssessment extends ReconcileSweepInput {
  allowed: boolean;
  reason?: ReconcileRefusal;
  /** Operator-facing explanation. Empty when allowed. */
  message: string;
  /** staleCount / fileBackedCount, 0 when there is nothing to divide. */
  ratio: number;
}

/**
 * Decide whether the reconcile sweep may proceed.
 *
 * Refuses when:
 *   1. the working-tree enumeration came back EMPTY while the source still has
 *      file-backed pages — "no files on disk" is far more often a broken read
 *      than a genuinely emptied repo; or
 *   2. the sweep would delete more than `RECONCILE_BULK_DELETE_RATIO` of the
 *      source's file-backed pages (only once the source is big enough for the
 *      ratio to mean anything).
 *
 * `allowBulkDelete` (CLI `--allow-bulk-delete`) overrides both. Unlike the
 * e2e database-identity guard, an escape hatch is correct here: genuinely
 * deleting most of a repo is a real thing a user does, and the sweep must
 * remain able to follow. What must not happen is doing it SILENTLY and
 * BY DEFAULT on the strength of an empty directory read.
 */
export function assessReconcileSweep(
  input: ReconcileSweepInput,
  opts: { allowBulkDelete?: boolean } = {},
): ReconcileSweepAssessment {
  const { enumeratedCount, fileBackedCount, staleCount } = input;
  const ratio = fileBackedCount > 0 ? staleCount / fileBackedCount : 0;
  const base = { ...input, ratio };

  // Nothing to delete: always fine, and never worth a warning.
  if (staleCount === 0) return { ...base, allowed: true, message: '' };

  if (opts.allowBulkDelete) return { ...base, allowed: true, message: '' };

  if (enumeratedCount === 0 && fileBackedCount > 0) {
    return {
      ...base,
      allowed: false,
      reason: 'empty_enumeration',
      message:
        `reconcile sweep refused: the working tree enumerated 0 syncable files, ` +
        `but this source has ${fileBackedCount} file-backed page(s). Deleting them ` +
        `would treat an empty directory read as "every file was deleted" — the ` +
        `2026-08-17 data-loss path. Check that the source's local_path is present, ` +
        `mounted, and fully checked out. If the repo really is empty, re-run with ` +
        `--allow-bulk-delete.`,
    };
  }

  if (fileBackedCount >= RECONCILE_RATIO_MIN_PAGES && ratio > RECONCILE_BULK_DELETE_RATIO) {
    const pct = (ratio * 100).toFixed(1);
    return {
      ...base,
      allowed: false,
      reason: 'bulk_delete_ratio',
      message:
        `reconcile sweep refused: would delete ${staleCount} of ${fileBackedCount} ` +
        `file-backed page(s) (${pct}%), above the ${RECONCILE_BULK_DELETE_RATIO * 100}% ` +
        `unattended ceiling. This is what a partially-checked-out or wrong working ` +
        `tree looks like. Verify the source's local_path, then re-run with ` +
        `--allow-bulk-delete if the deletion is intended.`,
    };
  }

  return { ...base, allowed: true, message: '' };
}
