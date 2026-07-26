/**
 * TAN-607 — early HEAD-equal up_to_date path must stamp last_sync_at.
 *
 * Pre-fix: performSync returned status=up_to_date when last_commit === HEAD
 * without writing sources.last_sync_at. Doctor lag + operator freshness used
 * last_sync_at, while fanout "fresh" used last_full_cycle_at — producing
 * false-fresh / multi-day lag reports on brains that were actually current.
 *
 * Post-fix: the early no-op path bookmarks last_sync_at (and newest_content_at
 * via writeSyncAnchor) the same way the totalChanges===0 path already did.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

describe('performSync up_to_date stamps last_sync_at (TAN-607)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await runSources(engine, ['add', 'testsrc-stamp', '--no-federated']);
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    const sources = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = 'testsrc-stamp'`,
    );
    if (sources.length === 0) {
      await runSources(engine, ['add', 'testsrc-stamp', '--no-federated']);
    }

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-stamp-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(
      join(repoPath, 'topics/alpha.md'),
      [
        '---',
        'type: concept',
        'title: Alpha',
        '---',
        '',
        'Stamp freshness regression content.',
      ].join('\n'),
    );
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('second no-op sync returns up_to_date and advances last_sync_at', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    const first = await performSync(engine, {
      repoPath,
      sourceId: 'testsrc-stamp',
      noPull: true,
      noEmbed: true,
    });
    expect(['first_sync', 'synced']).toContain(first.status);

    // Age the bookmark so a no-op can prove advancement.
    await engine.executeRaw(
      `UPDATE sources SET last_sync_at = now() - interval '3 days' WHERE id = $1`,
      ['testsrc-stamp'],
    );
    const aged = await engine.executeRaw<{ last_sync_at: string | Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      ['testsrc-stamp'],
    );
    const agedMs = new Date(aged[0].last_sync_at).getTime();

    const settled = await performSync(engine, {
      repoPath,
      sourceId: 'testsrc-stamp',
      noPull: true,
      noEmbed: true,
    });
    expect(settled.status).toBe('up_to_date');

    const after = await engine.executeRaw<{ last_sync_at: string | Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      ['testsrc-stamp'],
    );
    const afterMs = new Date(after[0].last_sync_at).getTime();
    expect(afterMs).toBeGreaterThan(agedMs);
    // Should be recent (within the last few minutes of wall clock).
    expect(Date.now() - afterMs).toBeLessThan(5 * 60 * 1000);
  });

  test('dry-run up_to_date does not advance last_sync_at', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    await performSync(engine, {
      repoPath,
      sourceId: 'testsrc-stamp',
      noPull: true,
      noEmbed: true,
    });
    await engine.executeRaw(
      `UPDATE sources SET last_sync_at = now() - interval '3 days' WHERE id = $1`,
      ['testsrc-stamp'],
    );
    const before = await engine.executeRaw<{ last_sync_at: string | Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      ['testsrc-stamp'],
    );
    const beforeIso = String(before[0].last_sync_at);

    const dry = await performSync(engine, {
      repoPath,
      sourceId: 'testsrc-stamp',
      noPull: true,
      noEmbed: true,
      dryRun: true,
    });
    expect(dry.status).toBe('up_to_date');

    const after = await engine.executeRaw<{ last_sync_at: string | Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      ['testsrc-stamp'],
    );
    expect(String(after[0].last_sync_at)).toBe(beforeIso);
  });
});
