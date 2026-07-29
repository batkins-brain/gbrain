/**
 * Tests for `gbrain apply-migrations` — the migration runner CLI.
 *
 * Unit-scope: exercises the pure helpers (parseArgs, indexCompleted, buildPlan,
 * statusForVersion). End-to-end integration against real orchestrators is
 * covered by test/e2e/migration-flow.test.ts (Lane C-5).
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testing } from '../src/commands/apply-migrations.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';
import type { Migration } from '../src/commands/migrations/types.ts';
import { v0_16_0 } from '../src/commands/migrations/v0_16_0.ts';
import { v0_18_0 } from '../src/commands/migrations/v0_18_0.ts';
import { withEnv } from './helpers/with-env.ts';

const {
  parseArgs,
  indexCompleted,
  buildPlan,
  statusForVersion,
  executeDryRunPlan,
} = __testing;

describe('parseArgs', () => {
  test('default flags', () => {
    const a = parseArgs([]);
    expect(a.list).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.yes).toBe(false);
    expect(a.nonInteractive).toBe(false);
    expect(a.mode).toBeUndefined();
    expect(a.specificMigration).toBeUndefined();
    expect(a.hostDir).toBeUndefined();
    expect(a.noAutopilotInstall).toBe(false);
  });

  test('--list / --dry-run / --yes / --non-interactive', () => {
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--yes']).yes).toBe(true);
    expect(parseArgs(['--non-interactive']).nonInteractive).toBe(true);
  });

  test('--mode accepts valid values', () => {
    expect(parseArgs(['--mode', 'always']).mode).toBe('always');
    expect(parseArgs(['--mode', 'pain_triggered']).mode).toBe('pain_triggered');
    expect(parseArgs(['--mode', 'off']).mode).toBe('off');
  });

  test('--migration and --host-dir parse values', () => {
    const a = parseArgs(['--migration', '0.11.0', '--host-dir', '/tmp/abc']);
    expect(a.specificMigration).toBe('0.11.0');
    expect(a.hostDir).toBe('/tmp/abc');
  });

  test('--no-autopilot-install flips flag', () => {
    expect(parseArgs(['--no-autopilot-install']).noAutopilotInstall).toBe(true);
  });

  test('--help sets help flag', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('indexCompleted + statusForVersion', () => {
  test('no entries → pending', () => {
    const idx = indexCompleted([]);
    expect(statusForVersion('0.11.0', idx)).toBe('pending');
  });

  test('one complete entry → complete', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'complete', mode: 'always' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('complete');
  });

  test('only partial entries → partial', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('partial');
  });

  test('partial then complete → complete (stopgap then v0.11.1 apply-migrations)', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
      { version: '0.11.0', status: 'complete', mode: 'always' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('complete');
  });

  test('only looks at the queried version', () => {
    const entries: CompletedMigrationEntry[] = [
      { version: '0.10.0', status: 'complete' },
    ];
    const idx = indexCompleted(entries);
    expect(statusForVersion('0.11.0', idx)).toBe('pending');
    expect(statusForVersion('0.10.0', idx)).toBe('complete');
  });
});

describe('buildPlan — diff against completed + installed VERSION', () => {
  test('fresh install (no entries) — v0.11.0 is pending when installed ≥ 0.11.0', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.applied).toEqual([]);
    expect(plan.partial).toEqual([]);
    expect(plan.pending.map(m => m.version)).toContain('0.11.0');
    // Future migrations (registered but newer than installed VERSION) land in
    // skippedFuture until the binary catches up. v0.13.0 = frontmatter graph,
    // v0.13.1 = Knowledge Runtime grandfather, v0.14.0 = shell jobs +
    // autopilot cooperative, v0.16.0 = subagent runtime, v0.18.0 = multi-
    // source brains, v0.18.1 = RLS hardening, v0.21.0 = Cathedral II
    // (renumbered from v0.20.0 after master shipped v0.20.x in parallel).
    expect(plan.skippedFuture.map(m => m.version)).toEqual(['0.12.0', '0.12.2', '0.13.0', '0.13.1', '0.14.0', '0.16.0', '0.18.0', '0.18.1', '0.21.0', '0.22.4', '0.28.0', '0.29.1', '0.31.0', '0.32.2']);
  });

  test('already applied → v0.11.0 lands in `applied` bucket, not pending', () => {
    const idx = indexCompleted([{ version: '0.11.0', status: 'complete' }]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.applied.map(m => m.version)).toContain('0.11.0');
    expect(plan.pending).toEqual([]);
  });

  test('stopgap wrote partial → v0.11.0 lands in `partial` bucket (resumable)', () => {
    const idx = indexCompleted([
      { version: '0.11.0', status: 'partial', apply_migrations_pending: true },
    ]);
    const plan = buildPlan(idx, '0.11.1');
    expect(plan.partial.map(m => m.version)).toContain('0.11.0');
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual([]);
  });

  test('Codex H9 regression: installed older than migration → skippedFuture, not skipped silently', () => {
    // Running a v0.10.x binary that somehow loaded a v0.11.0 migration registry:
    // migration is skippedFuture (wait for a newer install), NOT ignored.
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.10.5');
    expect(plan.skippedFuture.map(m => m.version)).toContain('0.11.0');
    expect(plan.pending).toEqual([]);
  });

  test('Codex H9 regression: installed > migration version → still runs (not skipped)', () => {
    // This is the critical bug Codex caught: the plan was "apply when version >
    // installed", which would SKIP v0.11.0 when running v0.11.1. The correct
    // rule is "apply when not in completed.jsonl AND version ≤ installed".
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.12.0');
    expect(plan.pending.map(m => m.version)).toContain('0.11.0');
    // v0.12.2, v0.13.0, v0.13.1, v0.14.0, v0.16.0, v0.18.0, v0.18.1, v0.21.0,
    // v0.22.4, v0.28.0, v0.29.1, v0.31.0 were added later; installed=0.12.0
    // means they belong in skippedFuture, not pending. v0.11.0 and v0.12.0
    // stay pending despite being ≤ installed — that is the H9 invariant.
    expect(plan.skippedFuture.map(m => m.version)).toEqual(['0.12.2', '0.13.0', '0.13.1', '0.14.0', '0.16.0', '0.18.0', '0.18.1', '0.21.0', '0.22.4', '0.28.0', '0.29.1', '0.31.0', '0.32.2']);
  });

  test('--migration filter narrows to one version', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1', '0.11.0');
    expect(plan.pending.map(m => m.version)).toEqual(['0.11.0']);
  });

  test('--migration filter for unknown version → empty plan', () => {
    const idx = indexCompleted([]);
    const plan = buildPlan(idx, '0.11.1', '99.99.99');
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual([]);
    expect(plan.partial).toEqual([]);
    expect(plan.skippedFuture).toEqual([]);
  });
});

// v0.36.1.x (cherry-pick #1062): list, dry-run, and "all migrations up to
// date" paths must exit 0 so shell scripts gating on the exit code work.
// Pre-fix, these `return` statements left the CLI dispatcher's implicit
// non-zero exit code in place when callers checked $?.
describe('runApplyMigrations exit codes (v0.36.1.x #1062)', () => {
  test('source contains process.exit(0) on list/dry-run/up-to-date branches', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/apply-migrations.ts', 'utf8');
    expect(src).toMatch(/cli\.list\s*\)\s*\{\s*printList\(plan,\s*installed\);\s*process\.exit\(0\);/);
    expect(src).toMatch(/cli\.dryRun[\s\S]{0,180}await executeDryRunPlan\(plan,\s*cli\);[\s\S]{0,80}process\.exit\(0\);/);
    expect(src).toMatch(/All migrations up to date[\s\S]{0,80}process\.exit\(0\)/);
  });
});

describe('executeDryRunPlan', () => {
  test('executes pending orchestrators in dry-run mode and renders exact target manifests', async () => {
    const observed: Array<{ dryRun: boolean; yes: boolean }> = [];
    const migration: Migration = {
      version: '0.32.2',
      featurePitch: { headline: 'Fence legacy facts' },
      orchestrator: async opts => {
        observed.push({ dryRun: opts.dryRun, yes: opts.yes });
        return {
          version: '0.32.2',
          status: 'complete',
          phases: [{ name: 'fence_facts', status: 'skipped', detail: 'dry-run' }],
          target_manifest: {
            version: '0.32.2',
            targets: [{
              source_id: 'default',
              target_markdown_slug: 'people/alice',
              fact_ids: ['41'],
            }],
          },
        } as Awaited<ReturnType<Migration['orchestrator']>>;
      },
    };
    const plan = {
      applied: [],
      partial: [],
      pending: [migration],
      skippedFuture: [],
      wedged: [],
    };
    const output: string[] = [];

    const results = await executeDryRunPlan(
      plan,
      parseArgs(['--dry-run']),
      line => output.push(line),
    );

    expect(observed).toEqual([{ dryRun: true, yes: false }]);
    expect(results).toHaveLength(1);
    expect(output.join('\n')).toContain('"target_markdown_slug": "people/alice"');
    expect(output.join('\n')).toContain('"fact_ids": [');
  });

  test('does not invoke applied or future orchestrators', async () => {
    let calls = 0;
    const migration: Migration = {
      version: '0.32.2',
      featurePitch: { headline: 'Must not run' },
      orchestrator: async () => {
        calls += 1;
        return { version: '0.32.2', status: 'complete', phases: [] };
      },
    };
    await executeDryRunPlan(
      {
        applied: [migration],
        partial: [],
        pending: [],
        skippedFuture: [migration],
        wedged: [],
      },
      parseArgs(['--dry-run']),
      () => {},
    );
    expect(calls).toBe(0);
  });

  test('legacy pending orchestrators do not write completion ledger during dry-run', async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'apply-migrations-dry-run-'));
    try {
      await withEnv({ GBRAIN_HOME: isolatedHome }, async () => {
        await executeDryRunPlan(
          {
            applied: [],
            partial: [],
            pending: [v0_16_0, v0_18_0],
            skippedFuture: [],
            wedged: [],
          },
          parseArgs(['--dry-run']),
          () => {},
        );
        expect(
          existsSync(join(isolatedHome, '.gbrain', 'migrations', 'completed.jsonl')),
        ).toBe(false);
      });
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});
