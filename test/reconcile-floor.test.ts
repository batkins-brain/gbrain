/**
 * Floor guard for the full-sync reconcile-delete sweep.
 *
 * The sweep infers deletion from ABSENCE: pages whose `source_path` is not in
 * the working-tree enumeration are deleted. On 2026-08-17 that emptied a
 * production brain (11,496 pages -> 34) because the enumeration came back empty
 * and "no files here" was treated as "every file was deleted".
 *
 * The first test replays that exact shape. If it ever fails, the guard has
 * regressed and the data-loss path is open again.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessReconcileSweep,
  RECONCILE_BULK_DELETE_RATIO,
  RECONCILE_RATIO_MIN_PAGES,
} from '../src/core/reconcile-floor.ts';

describe('assessReconcileSweep', () => {
  test('refuses the 2026-08-17 shape: empty enumeration, whole source stale', () => {
    const a = assessReconcileSweep({
      enumeratedCount: 0,
      fileBackedCount: 11462,
      staleCount: 11462,
    });
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe('empty_enumeration');
    expect(a.message).toContain('0 syncable files');
    expect(a.message).toContain('--allow-bulk-delete');
  });

  test('an empty enumeration is refused even for a small source', () => {
    const a = assessReconcileSweep({ enumeratedCount: 0, fileBackedCount: 3, staleCount: 3 });
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe('empty_enumeration');
  });

  test('normal incremental deletion is allowed', () => {
    // 5 of 500 files genuinely removed — the case the sweep exists for.
    const a = assessReconcileSweep({
      enumeratedCount: 495,
      fileBackedCount: 500,
      staleCount: 5,
    });
    expect(a.allowed).toBe(true);
    expect(a.reason).toBeUndefined();
    expect(a.message).toBe('');
  });

  test('refuses a bulk sweep above the ratio ceiling', () => {
    const a = assessReconcileSweep({
      enumeratedCount: 100,
      fileBackedCount: 1000,
      staleCount: 900,
    });
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe('bulk_delete_ratio');
    expect(a.message).toContain('900 of 1000');
  });

  test('allows deletion exactly AT the ratio ceiling (only above refuses)', () => {
    const staleCount = Math.floor(1000 * RECONCILE_BULK_DELETE_RATIO);
    const a = assessReconcileSweep({ enumeratedCount: 500, fileBackedCount: 1000, staleCount });
    expect(a.ratio).toBe(RECONCILE_BULK_DELETE_RATIO);
    expect(a.allowed).toBe(true);
  });

  test('small sources are exempt from the ratio rule (noise, not signal)', () => {
    // 3 of 4 pages stale is 75%, but the enumeration is non-empty so this is
    // an ordinary small-repo edit, not the failure shape.
    const a = assessReconcileSweep({ enumeratedCount: 1, fileBackedCount: 4, staleCount: 3 });
    expect(a.fileBackedCount).toBeLessThan(RECONCILE_RATIO_MIN_PAGES);
    expect(a.allowed).toBe(true);
  });

  test('--allow-bulk-delete overrides the empty enumeration', () => {
    const a = assessReconcileSweep(
      { enumeratedCount: 0, fileBackedCount: 11462, staleCount: 11462 },
      { allowBulkDelete: true },
    );
    expect(a.allowed).toBe(true);
  });

  test('--allow-bulk-delete overrides the ratio ceiling', () => {
    const a = assessReconcileSweep(
      { enumeratedCount: 100, fileBackedCount: 1000, staleCount: 900 },
      { allowBulkDelete: true },
    );
    expect(a.allowed).toBe(true);
  });

  test('nothing stale is always allowed and never warns', () => {
    // Notably true even when the enumeration is empty: with no stale pages
    // there is nothing to refuse, so an empty repo with no pages is quiet.
    const a = assessReconcileSweep({ enumeratedCount: 0, fileBackedCount: 0, staleCount: 0 });
    expect(a.allowed).toBe(true);
    expect(a.message).toBe('');
  });

  test('a source with no file-backed pages cannot divide by zero', () => {
    const a = assessReconcileSweep({ enumeratedCount: 0, fileBackedCount: 0, staleCount: 0 });
    expect(a.ratio).toBe(0);
    expect(Number.isFinite(a.ratio)).toBe(true);
  });

  test('refusal messages name the numbers an operator needs', () => {
    const bulk = assessReconcileSweep({
      enumeratedCount: 10, fileBackedCount: 1000, staleCount: 800,
    });
    expect(bulk.message).toContain('800');
    expect(bulk.message).toContain('1000');
    expect(bulk.message).toContain('80.0%');
  });

  test('the sweep in sync.ts is actually gated on the guard', () => {
    // A pure-function test proves the decision; this proves it is CONSULTED.
    // Without this, the guard could be silently unwired and every test above
    // would still pass while the data-loss path was wide open again.
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'sync.ts'), 'utf8');
    expect(src).toContain('assessReconcileSweep');
    expect(src).toContain('if (floor.allowed && staleSlugs.length > 0)');
    // The guard must be evaluated BEFORE the delete loop, not after it.
    expect(src.indexOf('assessReconcileSweep(')).toBeLessThan(src.indexOf('engine.deletePages(batch, deleteScopedOpts)'));
  });

  test('the guard reads the real enumeration size, not a constant', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'sync.ts'), 'utf8');
    expect(src).toContain('enumeratedCount: current.size');
    expect(src).toContain('fileBackedCount: rows.length');
    expect(src).toContain('staleCount: staleSlugs.length');
  });

  test('assessment echoes its inputs for logging', () => {
    const a = assessReconcileSweep({
      enumeratedCount: 7, fileBackedCount: 20, staleCount: 19,
    });
    expect(a.enumeratedCount).toBe(7);
    expect(a.fileBackedCount).toBe(20);
    expect(a.staleCount).toBe(19);
    expect(a.ratio).toBeCloseTo(0.95, 5);
  });
});
