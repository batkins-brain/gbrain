/**
 * TAN-610 graph/backlink acceptance harness tests.
 */

import { describe, expect, test, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { compareSnapshots, buildSnapshot, parseGraphFixtureJsonl, runGraphIntegrationHarness, type GraphFixtureRow } from '../src/eval/graph-integration/harness.ts';
import { runEvalGraphIntegration } from '../src/commands/eval-graph-integration.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';

const FIXTURE = `
{"kind":"node","node":{"slug":"people/alice-example","type":"person","title":"Alice Example","source_id":"default","authority_state":"active"}}
{"kind":"node","node":{"slug":"people/bob-example","type":"person","title":"Bob Example","source_id":"default","authority_state":"archived","successor_slug":"projects/alice-successor"}}
{"kind":"node","node":{"slug":"companies/acme-example","type":"company","title":"Acme Example","source_id":"default","authority_state":"active"}}
{"kind":"node","node":{"slug":"projects/alice-successor","type":"project","title":"Alice Successor","source_id":"default","authority_state":"active"}}
{"kind":"node","node":{"slug":"source/primary","type":"source","title":"Primary Source","source_id":"primary","authority_state":"active"}}
{"kind":"node","node":{"slug":"source/secondary","type":"source","title":"Secondary Source","source_id":"secondary","authority_state":"active"}}
{"kind":"node","node":{"slug":"companies/acme-secondary","type":"company","title":"Acme Secondary","source_id":"secondary","authority_state":"active"}}
{"kind":"edge","edge":{"from":"people/alice-example","to":"companies/acme-example","type":"works_at","source_id":"default","evidence":"profile mention"}}
{"kind":"edge","edge":{"from":"people/alice-example","to":"companies/acme-example","type":"works_at","source_id":"default","evidence":"duplicate row to test dedupe"}}
{"kind":"edge","edge":{"from":"people/bob-example","to":"projects/alice-successor","type":"successor_of","source_id":"default","evidence":"archive handoff"}}
{"kind":"edge","edge":{"from":"people/bob-example","to":"people/missing-example","type":"mentions","source_id":"default","evidence":"broken ref"}}
{"kind":"edge","edge":{"from":"source/primary","to":"source/secondary","type":"source","source_id":"primary","from_source_id":"primary","to_source_id":"secondary","evidence":"cross-source retrieval"}}
{"kind":"edge","edge":{"from":"people/alice-example","to":"companies/acme-secondary","type":"works_at","source_id":"default","evidence":"source-scoped mismatch"}}
`.trim();

describe('graph-integration harness', () => {
  test('rejects empty and structurally invalid fixture rows', () => {
    expect(() => parseGraphFixtureJsonl('')).toThrow('at least one node or edge row');
    expect(() => parseGraphFixtureJsonl('{}')).toThrow('line 1: kind must be "node" or "edge"');
    expect(() => parseGraphFixtureJsonl('{"kind":"node","node":{}}')).toThrow('line 1: node.slug');
    expect(() => parseGraphFixtureJsonl('{"kind":"edge","edge":{"from":"a","to":"b","type":"","source_id":"default"}}')).toThrow('line 1: edge.type');
    expect(() => parseGraphFixtureJsonl('{"kind":"node","node":{"slug":"source/a","type":"source","title":"A","source_id":"INVALID"}}')).toThrow('invalid node.source_id');
    expect(() => parseGraphFixtureJsonl('{"kind":"node","node":{"slug":"../invalid","type":"source","title":"A","source_id":"default"}}')).toThrow('invalid node.slug');
  });

  test('accepts schema-pack-extensible page and relation types', () => {
    const rows = parseGraphFixtureJsonl(`
{"kind":"node","node":{"slug":"meetings/review","type":"meeting","title":"Review","source_id":"default"}}
{"kind":"node","node":{"slug":"decisions/custom","type":"decision","title":"Custom Decision","source_id":"default"}}
{"kind":"edge","edge":{"from":"meetings/review","to":"decisions/custom","type":"custom_relation","source_id":"default"}}
    `);
    expect(rows[0]?.node?.type).toBe('meeting');
    expect(rows[1]?.node?.type).toBe('decision');
    expect(rows[2]?.edge?.type).toBe('custom_relation');
    expect(compareSnapshots(buildSnapshot(rows)).dry_run.typed_relations).toBe(1);
  });

  test('parses and scores fixture metrics deterministically', () => {
    const rows = parseGraphFixtureJsonl(FIXTURE);
    expect(rows).toHaveLength(13);
    const report = compareSnapshots(buildSnapshot(rows));
    expect(report.dry_run.valid_outgoing).toBe(4);
    expect(report.dry_run.incoming_backlinks).toBe(4);
    expect(report.dry_run.typed_relations).toBe(4);
    expect(report.dry_run.unresolved_targets).toBe(2);
    expect(report.dry_run.broken_references).toBe(2);
    expect(report.dry_run.duplicate_edges).toBe(1);
    expect(report.dry_run.cross_source_ambiguity).toBe(1);
    expect(report.dry_run.authority_lifecycle_compliance).toBe(4);
    expect(report.coverage.dry_run_nodes).toBe(7);
    expect(report.coverage.dry_run_edges).toBe(6);
    expect(report.live_read_only).toBeNull();
    expect(report.comparisons).toHaveLength(0);
    expect(report.notes[0]).toContain('fixture-only report');
  });

  test('live-read-only comparison uses source-scoped retrieval and frontmatter metadata', () => {
    const rows = parseGraphFixtureJsonl(FIXTURE);
    const dry = buildSnapshot(rows);
    const live = buildSnapshot(rows.filter(row => row.edge?.to !== 'people/missing-example' && row.edge?.to !== 'companies/acme-secondary'));
    const report = compareSnapshots(dry, live);
    expect(report.live_read_only?.unresolved_targets).toBe(0);
    expect(report.live_read_only?.broken_references).toBe(0);
    expect(report.coverage.live_read_only_edges).toBe(4);
    expect(report.notes.some(n => n.includes('later repair would reduce'))).toBe(false);
    expect(report.comparisons.find(c => c.metric === 'broken_references')?.delta).toBe(-2);
  });

  test('typed relations require a non-empty type while permitting custom types', () => {
    const nodes = [
      { slug: 'source/from', type: 'source' as const, title: 'From', source_id: 'default', authority_state: 'active' as const },
      { slug: 'source/to', type: 'source' as const, title: 'To', source_id: 'default', authority_state: 'active' as const },
    ];
    const report = compareSnapshots({
      nodes,
      edges: [
        { from: 'source/from', to: 'source/to', type: '' as any, source_id: 'default' },
        { from: 'source/from', to: 'source/to', type: 'custom_relation' as any, source_id: 'default' },
      ],
    });
    expect(report.dry_run.valid_outgoing).toBe(2);
    expect(report.dry_run.incoming_backlinks).toBe(2);
    expect(report.dry_run.typed_relations).toBe(1);
  });

  test('same-source edge remains unambiguous when its target slug exists in another source', () => {
    const report = compareSnapshots({
      nodes: [
        { slug: 'source/from', type: 'source', title: 'From', source_id: 'primary', authority_state: 'active' },
        { slug: 'source/shared', type: 'source', title: 'Primary Shared', source_id: 'primary', authority_state: 'active' },
        { slug: 'source/shared', type: 'source', title: 'Secondary Shared', source_id: 'secondary', authority_state: 'active' },
      ],
      edges: [
        { from: 'source/from', to: 'source/shared', type: 'source', source_id: 'primary' },
      ],
    });
    expect(report.dry_run.valid_outgoing).toBe(1);
    expect(report.dry_run.unresolved_targets).toBe(0);
    expect(report.dry_run.cross_source_ambiguity).toBe(0);
  });

  test('duplicate-edge identity cannot collide through relation delimiters', () => {
    const report = compareSnapshots({
      nodes: [
        { slug: 'a', type: 'source', title: 'A', source_id: 'default', authority_state: 'active' },
        { slug: 'b', type: 'source', title: 'B', source_id: 'default', authority_state: 'active' },
        { slug: 'b|c', type: 'source', title: 'B Pipe C', source_id: 'default', authority_state: 'active' },
      ],
      edges: [
        { from: 'a', to: 'b', type: 'c|d' as any, source_id: 'default' },
        { from: 'a', to: 'b|c', type: 'd' as any, source_id: 'default' },
      ],
    });
    expect(report.dry_run.duplicate_edges).toBe(0);
  });

  test('missing origin is broken without being an unresolved target', () => {
    const report = compareSnapshots({
      nodes: [
        { slug: 'target', type: 'source', title: 'Target', source_id: 'default', authority_state: 'active' },
      ],
      edges: [
        { from: 'missing-origin', to: 'target', type: 'mentions', source_id: 'default' },
      ],
    });
    expect(report.dry_run.valid_outgoing).toBe(0);
    expect(report.dry_run.broken_references).toBe(1);
    expect(report.dry_run.unresolved_targets).toBe(0);

    const missingTarget = compareSnapshots({
      nodes: [
        { slug: 'origin', type: 'source', title: 'Origin', source_id: 'default', authority_state: 'active' },
      ],
      edges: [
        { from: 'origin', to: 'missing-target', type: 'mentions', source_id: 'default' },
      ],
    });
    expect(missingTarget.dry_run.broken_references).toBe(1);
    expect(missingTarget.dry_run.unresolved_targets).toBe(1);
  });

  test('fixture-only CLI skips live readSnapshot and says so explicitly', async () => {
    const fixturePath = Bun.pathToFileURL('/tmp/tan610-fixture.jsonl').pathname;
    await Bun.write(fixturePath, FIXTURE);
    const engine = {
      executeRaw: mock(async () => {
        throw new Error('unexpected live SQL');
      }),
    } as any;
    const log = mock(() => {});
    const originalLog = console.log;
    console.log = log as any;
    try {
      await runEvalGraphIntegration(engine, [fixturePath]);
    } finally {
      console.log = originalLog;
    }
    expect(engine.executeRaw).toHaveBeenCalledTimes(0);
    expect(log.mock.calls.flat().join('\n')).toContain('fixture-only default');
    expect(log.mock.calls.flat().join('\n')).toContain('live-read-only: omitted');
  });

  test('fixture-only CLI runs end-to-end without a configured brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-graph-fixture-'));
    const fixturePath = join(home, 'fixture.jsonl');
    await Bun.write(fixturePath, FIXTURE);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    env.GBRAIN_HOME = home;

    try {
      const proc = Bun.spawn(
        ['bun', 'run', 'src/cli.ts', 'eval', 'graph-integration', fixturePath, '--json'],
        {
          cwd: new URL('..', import.meta.url).pathname,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain('No brain configured');
      expect(JSON.parse(stdout).live_read_only).toBeNull();
      expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('live-read-only CLI uses a probe-only connection without migrations', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-graph-live-'));
    const databasePath = join(home, 'brain-data');
    const fixturePath = join(home, 'fixture.jsonl');
    const configDir = join(home, '.gbrain');
    mkdirSync(configDir, { recursive: true });
    await Bun.write(fixturePath, FIXTURE);

    const setup = new PGlite(databasePath);
    await setup.exec(`
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO config (key, value) VALUES ('version', '1');
      CREATE TABLE pages (
        id SERIAL PRIMARY KEY,
        slug TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        source_id TEXT NOT NULL,
        frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE links (
        from_page_id INTEGER NOT NULL,
        to_page_id INTEGER NOT NULL,
        link_type TEXT NOT NULL,
        link_source TEXT
      );
      INSERT INTO pages (slug, type, title, source_id, frontmatter, deleted_at)
      VALUES
        ('source/fixture', 'source', 'Fixture', '24-105', '{"authority_state":"active"}', NULL),
        ('source/active', 'source', 'Active', '24-105', '{"authority_state":"active"}', NULL),
        ('source/deleted', 'source', 'Deleted', '24-105', '{"authority_state":"active"}', NOW()),
        ('source/external', 'source', 'External', 'shared', '{"authority_state":"active"}', NULL),
        ('source/external-deleted', 'source', 'External Deleted', 'shared', '{"authority_state":"active"}', NOW());
      INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT fp.id, tp.id, 'source', 'manual'
        FROM pages fp, pages tp
       WHERE fp.slug = 'source/active' AND tp.slug = 'source/external';
      INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT fp.id, tp.id, 'source', 'manual'
        FROM pages fp, pages tp
       WHERE fp.slug = 'source/deleted' AND tp.slug = 'source/external';
      INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT fp.id, tp.id, 'source', 'manual'
        FROM pages fp, pages tp
       WHERE fp.slug = 'source/active' AND tp.slug = 'source/external-deleted';
    `);
    await setup.close();
    await Bun.write(
      join(configDir, 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: databasePath }),
    );

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    env.GBRAIN_HOME = home;

    try {
      const proc = Bun.spawn(
        [
          'bun',
          'run',
          'src/cli.ts',
          'eval',
          'graph-integration',
          fixturePath,
          '--json',
          '--live-read-only',
          '--source',
          '24-105',
        ],
        {
          cwd: new URL('..', import.meta.url).pathname,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain('Schema version');
      const report = JSON.parse(stdout);
      expect(report.live_source_scope).toBe('24-105');
      expect(report.coverage.live_read_only_nodes).toBe(3);
      expect(report.coverage.live_read_only_edges).toBe(1);
      expect(report.live_read_only.typed_relations).toBe(1);
      expect(report.live_read_only.unresolved_targets).toBeNull();
      expect(report.live_metric_coverage.fixture_only).toEqual([
        'unresolved_targets',
        'broken_references',
        'cross_source_ambiguity',
      ]);

      const verify = new PGlite(databasePath);
      const version = await verify.query<{ value: string }>(
        `SELECT value FROM config WHERE key = 'version'`,
      );
      await verify.close();
      expect(version.rows[0]?.value).toBe('1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test('--live-read-only requires --source and scopes SQL by source', async () => {
    const fixturePath = Bun.pathToFileURL('/tmp/tan610-fixture-live.jsonl').pathname;
    await Bun.write(fixturePath, FIXTURE);
    const executeRaw = mock(async (sql: string, params: unknown[]) => {
      expect(params).toEqual(['24-105']);
      if (sql.includes('FROM pages')) {
        expect(sql).toContain('WHERE p.source_id = $1');
        expect(sql).toContain('p.deleted_at IS NULL');
        expect(sql).not.toContain('SELECT l.to_page_id');
        return [
          { slug: 'source/24-105-root', type: 'source', title: '24-105 Root', source_id: '24-105', frontmatter: { source_id: 'stale-other-source', authority_state: 'active' } },
        ];
      }
      expect(sql).toContain('WHERE fp.source_id = $1');
      expect(sql).toContain('fp.deleted_at IS NULL');
      expect(sql).toContain('tp.deleted_at IS NULL');
      return [
        { from_slug: 'source/24-105-root', to_slug: 'source/24-105-target', link_type: 'source', from_source_id: '24-105', to_source_id: 'shared', evidence: 'live' },
      ];
    });
    const engine = { executeRaw } as any;
    const log = mock(() => {});
    const originalLog = console.log;
    console.log = log as any;
    try {
      await runEvalGraphIntegration(engine, [fixturePath, '--json', '--live-read-only', '--source', '24-105']);
    } finally {
      console.log = originalLog;
    }
    expect(executeRaw).toHaveBeenCalledTimes(2);
    const report = JSON.parse(log.mock.calls.flat().join('\n'));
    expect(report.live_source_scope).toBe('24-105');
    expect(report.live_read_only.unresolved_targets).toBeNull();
    expect(report.live_read_only.broken_references).toBeNull();
    expect(report.live_read_only.cross_source_ambiguity).toBeNull();
    expect(report.comparisons.some((row: any) => row.metric === 'unresolved_targets')).toBe(false);
    expect(report.live_metric_coverage.fixture_only).toEqual([
      'unresolved_targets',
      'broken_references',
      'cross_source_ambiguity',
    ]);
  });

  test('--live-read-only without --source is rejected before SQL', async () => {
    const fixturePath = Bun.pathToFileURL('/tmp/tan610-fixture-missing-source.jsonl').pathname;
    await Bun.write(fixturePath, FIXTURE);
    const executeRaw = mock(async () => {
      throw new Error('should not run');
    });
    const engine = { executeRaw } as any;
    const error = mock(() => {});
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    console.error = error as any;
    try {
      await runEvalGraphIntegration(engine, [fixturePath, '--live-read-only']);
      expect(currentExitCode()).toBe(2);
    } finally {
      console.error = originalError;
      _resetCliExitVerdictForTests();
      process.exitCode = originalExitCode ?? 0;
    }
    expect(executeRaw).toHaveBeenCalledTimes(0);
    expect(error.mock.calls.flat().join('\n')).toContain('Missing required --source <id> when using --live-read-only.');
  });

  test('fixture input errors use the repository-owned CLI verdict', async () => {
    const error = mock(() => {});
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    console.error = error as any;
    try {
      await runEvalGraphIntegration(null, []);
      expect(currentExitCode()).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('Usage: gbrain eval graph-integration');

      _resetCliExitVerdictForTests();
      process.exitCode = 0;
      error.mockClear();

      const missingFixture = join(tmpdir(), `tan610-missing-${crypto.randomUUID()}.jsonl`);
      await runEvalGraphIntegration(null, [missingFixture]);
      expect(currentExitCode()).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('Cannot read fixture:');
    } finally {
      console.error = originalError;
      _resetCliExitVerdictForTests();
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test('live CLI validates source and fixture before connecting', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-graph-invalid-'));
    const fixturePath = join(home, 'fixture.jsonl');
    const malformedFixture = join(home, 'malformed.jsonl');
    const missingFixture = join(home, 'missing.jsonl');
    await Bun.write(fixturePath, FIXTURE);
    await Bun.write(malformedFixture, '{}\n');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    env.GBRAIN_HOME = home;

    const run = async (args: string[]) => {
      const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'eval', 'graph-integration', ...args], {
        cwd: new URL('..', import.meta.url).pathname,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode: await proc.exited, stdout, stderr };
    };

    try {
      const invalidSource = await run([
        fixturePath,
        '--live-read-only',
        '--source',
        '--json',
      ]);
      expect(invalidSource.exitCode).toBe(2);
      expect(invalidSource.stderr).toContain('Missing value for --source.');
      expect(invalidSource.stderr).not.toContain('No brain configured');

      const missingFixtureName = await run([
        fixturePath,
        '--fixture-name',
        '--json',
      ]);
      expect(missingFixtureName.exitCode).toBe(2);
      expect(missingFixtureName.stderr).toContain('Missing value for --fixture-name.');
      expect(missingFixtureName.stderr).not.toContain('No brain configured');

      const shortFixtureName = await run([
        fixturePath,
        '--fixture-name',
        '-x',
        '--json',
      ]);
      expect(shortFixtureName.exitCode).toBe(2);
      expect(shortFixtureName.stderr).toContain('Missing value for --fixture-name.');
      expect(shortFixtureName.stderr).not.toContain('No brain configured');

      const helpShapedSource = await run([
        fixturePath,
        '--live-read-only',
        '--source',
        '-h',
      ]);
      expect(helpShapedSource.exitCode).toBe(2);
      expect(helpShapedSource.stderr).toContain('Missing value for --source.');
      expect(helpShapedSource.stderr).not.toContain('No brain configured');

      const sourceWithoutLive = await run([
        fixturePath,
        '--source',
        'default',
        '--json',
      ]);
      expect(sourceWithoutLive.exitCode).toBe(2);
      expect(sourceWithoutLive.stderr).toContain('--source requires --live-read-only.');
      expect(sourceWithoutLive.stderr).not.toContain('No brain configured');

      for (const sourceId of ['../invalid', 'INVALID']) {
        const rejectedSource = await run([
          fixturePath,
          '--live-read-only',
          '--source',
          sourceId,
          '--json',
        ]);
        expect(rejectedSource.exitCode).toBe(2);
        expect(rejectedSource.stderr).toContain('Invalid source_id:');
        expect(rejectedSource.stderr).not.toContain('No brain configured');
      }

      const typoLiveFlag = await run([
        fixturePath,
        '--live-readonly',
        '--source',
        '24-105',
        '--json',
      ]);
      expect(typoLiveFlag.exitCode).toBe(2);
      expect(typoLiveFlag.stderr).toContain('Unknown option: --live-readonly');
      expect(typoLiveFlag.stderr).not.toContain('No brain configured');

      for (const sources of [
        ['24-105', '../invalid'],
        ['../invalid', '24-105'],
      ]) {
        const duplicateSource = await run([
          fixturePath,
          '--live-read-only',
          '--source',
          sources[0]!,
          '--source',
          sources[1]!,
          '--json',
        ]);
        expect(duplicateSource.exitCode).toBe(2);
        expect(duplicateSource.stderr).toContain('Duplicate option: --source');
        expect(duplicateSource.stderr).not.toContain('No brain configured');
      }

      const duplicateFixture = await run([
        fixturePath,
        fixturePath,
        '--json',
      ]);
      expect(duplicateFixture.exitCode).toBe(2);
      expect(duplicateFixture.stderr).toContain('Unexpected extra fixture argument:');
      expect(duplicateFixture.stderr).not.toContain('No brain configured');

      const missingFixtureArg = await run([
        '--live-read-only',
        '--source',
        '24-105',
        '--json',
      ]);
      expect(missingFixtureArg.exitCode).toBe(2);
      expect(missingFixtureArg.stderr).toContain('Usage: gbrain eval graph-integration');
      expect(missingFixtureArg.stderr).not.toContain('No brain configured');

      const unreadableFixture = await run([
        missingFixture,
        '--live-read-only',
        '--source',
        '24-105',
        '--json',
      ]);
      expect(unreadableFixture.exitCode).toBe(2);
      expect(unreadableFixture.stderr).toContain('Cannot read fixture:');
      expect(unreadableFixture.stderr).not.toContain('No brain configured');

      const invalidStructure = await run([
        malformedFixture,
        '--live-read-only',
        '--source',
        '24-105',
        '--json',
      ]);
      expect(invalidStructure.exitCode).toBe(2);
      expect(invalidStructure.stderr).toContain('Cannot read fixture: graph fixture line 1: kind');
      expect(invalidStructure.stderr).not.toContain('No brain configured');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
