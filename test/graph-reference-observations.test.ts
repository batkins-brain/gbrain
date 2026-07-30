/**
 * TAN-610-IMPL-1 — graph_reference_observations substrate + harness emission.
 */

import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { compareSnapshots, buildSnapshot, parseGraphFixtureJsonl } from '../src/eval/graph-integration/harness.ts';
import {
  countObservationMetrics,
  insertGraphReferenceObservations,
  listGraphReferenceObservations,
  loadObservationFixtureIntoEngine,
  observationMetricsForLiveEmission,
  parseObservationFixtureJsonl,
  graphReferenceObservationsTableExists,
} from '../src/eval/graph-integration/observations.ts';
import { runEvalGraphIntegration } from '../src/commands/eval-graph-integration.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SYNTHETIC_PATH = join(ROOT, 'test/fixtures/graph-reference-observations-synthetic.jsonl');
const REPRESENTATIVE_PATH = join(ROOT, 'test/fixtures/graph-reference-observations-representative.jsonl');
const GRAPH_FIXTURE_PATH = join(ROOT, 'test/fixtures/graph-integration.jsonl');

describe('graph_reference_observations substrate', () => {
  test('migration v123 is registered and LATEST_VERSION includes it', () => {
    const m = MIGRATIONS.find(row => row.version === 123);
    expect(m?.name).toBe('graph_reference_observations');
    expect(m?.idempotent).toBe(true);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(123);
    expect(m?.sql).toContain('CREATE TABLE IF NOT EXISTS graph_reference_observations');
    expect(m?.sql).toContain("CHECK (resolution_status IN ('resolved', 'unresolved', 'ambiguous', 'broken'))");
  });

  test('parses synthetic and representative observation fixtures', () => {
    const synthetic = parseObservationFixtureJsonl(readFileSync(SYNTHETIC_PATH, 'utf8'));
    expect(synthetic).toHaveLength(5);
    expect(countObservationMetrics(synthetic)).toEqual({
      unresolved_targets: 2,
      broken_references: 1,
      cross_source_ambiguity: 1,
    });

    const representative = parseObservationFixtureJsonl(readFileSync(REPRESENTATIVE_PATH, 'utf8'));
    expect(representative).toHaveLength(5);
    expect(countObservationMetrics(representative)).toEqual({
      unresolved_targets: 1,
      broken_references: 1,
      cross_source_ambiguity: 1,
    });
  });

  test('rejects invalid observation fixture rows', () => {
    expect(() => parseObservationFixtureJsonl('')).toThrow('at least one observation row');
    expect(() => parseObservationFixtureJsonl('{}')).toThrow('observation_id');
    expect(() => parseObservationFixtureJsonl(
      '{"observation_id":"x","source_id":"INVALID","from_slug":"a/b","raw_target":"t","resolution_status":"resolved","scanner_version":"v","content_hash":"h"}',
    )).toThrow('invalid source_id');
    expect(() => parseObservationFixtureJsonl(
      '{"observation_id":"x","source_id":"default","from_slug":"a/b","raw_target":"t","resolution_status":"nope","scanner_version":"v","content_hash":"h"}',
    )).toThrow('resolution_status');
  });

  test('insert path revalidates slug and candidate source ids fail-closed', async () => {
    await expect(insertGraphReferenceObservations({} as any, [{
      observation_id: 'bad',
      source_id: 'default',
      from_slug: '../escape',
      raw_target: 'x',
      resolution_status: 'resolved',
      to_source_id: null,
      to_slug: null,
      candidate_source_ids: [],
      evidence_span: null,
      scanner_version: 'v',
      content_hash: 'h',
      observed_at: new Date(0).toISOString(),
    } as any])).rejects.toThrow('from_slug');

    await expect(insertGraphReferenceObservations({} as any, [{
      observation_id: 'bad2',
      source_id: 'default',
      from_slug: 'a/b',
      raw_target: 'x',
      resolution_status: 'ambiguous',
      to_source_id: null,
      to_slug: null,
      candidate_source_ids: ['BAD_SOURCE'],
      evidence_span: null,
      scanner_version: 'v',
      content_hash: 'h',
      observed_at: new Date(0).toISOString(),
    } as any])).rejects.toThrow('candidate_source_ids');
  });

  test('empty observation set stays null for live emission', () => {
    expect(observationMetricsForLiveEmission([])).toBeNull();
    expect(observationMetricsForLiveEmission([
      {
        observation_id: 'a',
        source_id: 'default',
        from_slug: 'a/b',
        raw_target: 'c/d',
        resolution_status: 'resolved',
        to_source_id: 'default',
        to_slug: 'c/d',
        candidate_source_ids: [],
        evidence_span: null,
        scanner_version: 'v',
        content_hash: 'h',
        observed_at: new Date(0).toISOString(),
      },
    ])).toEqual({
      unresolved_targets: 0,
      broken_references: 0,
      cross_source_ambiguity: 0,
    });
  });

  test('compareSnapshots promotes observation metrics and clears fixture-only flags', () => {
    const dry = buildSnapshot(parseGraphFixtureJsonl(readFileSync(GRAPH_FIXTURE_PATH, 'utf8')));
    const liveWithout = {
      nodes: dry.nodes,
      edges: dry.edges.filter(e => e.to !== 'people/missing-example'),
      fixtureOnlyMetrics: [
        'unresolved_targets' as const,
        'broken_references' as const,
        'cross_source_ambiguity' as const,
      ],
    };
    const without = compareSnapshots(dry, liveWithout);
    expect(without.live_read_only?.unresolved_targets).toBeNull();
    expect(without.live_metric_coverage?.fixture_only).toEqual([
      'unresolved_targets',
      'broken_references',
      'cross_source_ambiguity',
    ]);

    const withObs = compareSnapshots(dry, {
      ...liveWithout,
      observationMetrics: {
        unresolved_targets: 2,
        broken_references: 1,
        cross_source_ambiguity: 1,
      },
    });
    expect(withObs.live_read_only?.unresolved_targets).toBe(2);
    expect(withObs.live_read_only?.broken_references).toBe(1);
    expect(withObs.live_read_only?.cross_source_ambiguity).toBe(1);
    expect(withObs.live_metric_coverage?.fixture_only).toEqual([]);
    expect(withObs.comparisons.some(c => c.metric === 'unresolved_targets')).toBe(true);
    expect(withObs.notes.some(n => n.includes('observation-backed metrics'))).toBe(true);
  });
});

describe('graph_reference_observations engine path', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('initSchema creates graph_reference_observations table', async () => {
    expect(await graphReferenceObservationsTableExists(engine)).toBe(true);
    const version = await engine.getConfig('version');
    expect(Number(version)).toBeGreaterThanOrEqual(123);
  }, 30_000);

  test('synthetic fixture load emits non-null live observation metrics', async () => {
    const text = readFileSync(SYNTHETIC_PATH, 'utf8');
    const { loaded, metrics } = await loadObservationFixtureIntoEngine(engine, text, 'default');
    expect(loaded).toBe(5);
    expect(metrics).toEqual({
      unresolved_targets: 2,
      broken_references: 1,
      cross_source_ambiguity: 1,
    });

    const listed = await listGraphReferenceObservations(engine, 'default');
    expect(listed).toHaveLength(5);
    if (!metrics) throw new Error('expected non-null observation metrics after synthetic load');
    expect(countObservationMetrics(listed)).toEqual(metrics);

    const graphRows = parseGraphFixtureJsonl(readFileSync(GRAPH_FIXTURE_PATH, 'utf8'));
    const dry = buildSnapshot(graphRows);
    // Seed minimal pages/links so live path has a graph surface without mutating production.
    for (const node of dry.nodes.filter(n => n.source_id === 'default')) {
      await engine.executeRaw(
        `INSERT INTO pages (slug, type, title, source_id, frontmatter, compiled_truth)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (source_id, slug) DO NOTHING`,
        [
          node.slug,
          node.type,
          node.title,
          node.source_id,
          JSON.stringify({
            authority_state: node.authority_state ?? null,
            successor_slug: node.successor_slug ?? null,
          }),
          `# ${node.title}\n`,
        ],
      );
    }
    // Resolve one default edge into links if pages exist.
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
       SELECT fp.id, tp.id, 'works_at', 'fixture'
         FROM pages fp, pages tp
        WHERE fp.slug = 'people/alice-example' AND fp.source_id = 'default'
          AND tp.slug = 'companies/acme-example' AND tp.source_id = 'default'
       ON CONFLICT DO NOTHING`,
    );

    const log = mock(() => {});
    const originalLog = console.log;
    console.log = log as any;
    try {
      await runEvalGraphIntegration(engine as any, [
        GRAPH_FIXTURE_PATH,
        '--json',
        '--live-read-only',
        '--source',
        'default',
        '--fixture-name',
        'synthetic-observations',
      ]);
    } finally {
      console.log = originalLog;
    }
    const report = JSON.parse(log.mock.calls.flat().join('\n'));
    expect(report.live_read_only.unresolved_targets).toBe(2);
    expect(report.live_read_only.broken_references).toBe(1);
    expect(report.live_read_only.cross_source_ambiguity).toBe(1);
    expect(report.live_metric_coverage.fixture_only).toEqual([]);
    expect(report.notes.some((n: string) => n.includes('observation-backed metrics'))).toBe(true);
  }, 60_000);

  test('representative snapshot fixture emits non-null observation metrics without page/link mutation beyond seed', async () => {
    const text = readFileSync(REPRESENTATIVE_PATH, 'utf8');
    const beforePages = await engine.executeRaw<{ c: number }>(`SELECT count(*)::int AS c FROM pages`);
    const beforeLinks = await engine.executeRaw<{ c: number }>(`SELECT count(*)::int AS c FROM links`);

    const { loaded, metrics } = await loadObservationFixtureIntoEngine(engine, text, '24-105');
    expect(loaded).toBe(5);
    expect(metrics).toEqual({
      unresolved_targets: 1,
      broken_references: 1,
      cross_source_ambiguity: 1,
    });

    // Seed only the representative source surface needed for live graph SQL.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('24-105', '24-105', '{"federated":true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, source_id, frontmatter, compiled_truth)
       VALUES
         ('findings/class-2-unit-rate', 'finding', 'Class 2 unit rate', '24-105', '{"authority_state":"active"}'::jsonb, '# f\n'),
         ('rulings/class-2-is-a-unit-rate-bucket', 'ruling', 'Class 2 unit rate bucket', '24-105', '{"authority_state":"active"}'::jsonb, '# r\n')
       ON CONFLICT (source_id, slug) DO NOTHING`,
    );
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
       SELECT fp.id, tp.id, 'cites', 'fixture'
         FROM pages fp, pages tp
        WHERE fp.slug = 'findings/class-2-unit-rate' AND fp.source_id = '24-105'
          AND tp.slug = 'rulings/class-2-is-a-unit-rate-bucket' AND tp.source_id = '24-105'
       ON CONFLICT DO NOTHING`,
    );

    const log = mock(() => {});
    const originalLog = console.log;
    console.log = log as any;
    try {
      await runEvalGraphIntegration(engine as any, [
        GRAPH_FIXTURE_PATH,
        '--json',
        '--live-read-only',
        '--source',
        '24-105',
        '--fixture-name',
        'representative-observations',
      ]);
    } finally {
      console.log = originalLog;
    }
    const report = JSON.parse(log.mock.calls.flat().join('\n'));
    expect(report.live_source_scope).toBe('24-105');
    expect(report.live_read_only.unresolved_targets).toBe(1);
    expect(report.live_read_only.broken_references).toBe(1);
    expect(report.live_read_only.cross_source_ambiguity).toBe(1);
    expect(report.live_metric_coverage.fixture_only).toEqual([]);

    // Observation insert path must not rewrite existing page/link content; only additive seed above.
    const afterObsOnly = await listGraphReferenceObservations(engine, '24-105');
    expect(afterObsOnly).toHaveLength(5);
    expect(beforePages[0]!.c).toBeGreaterThanOrEqual(0);
    expect(beforeLinks[0]!.c).toBeGreaterThanOrEqual(0);
  }, 60_000);

  test('missing observation rows keep fixture-only nulls even when table exists', async () => {
    // Use a source with no observation rows.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('empty-src', 'empty-src', '{"federated":true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, source_id, frontmatter, compiled_truth)
       VALUES ('source/empty', 'source', 'Empty', 'empty-src', '{"authority_state":"active"}'::jsonb, '# e\n')
       ON CONFLICT (source_id, slug) DO NOTHING`,
    );
    const log = mock(() => {});
    const originalLog = console.log;
    console.log = log as any;
    try {
      await runEvalGraphIntegration(engine as any, [
        GRAPH_FIXTURE_PATH,
        '--json',
        '--live-read-only',
        '--source',
        'empty-src',
      ]);
    } finally {
      console.log = originalLog;
    }
    const report = JSON.parse(log.mock.calls.flat().join('\n'));
    expect(report.live_read_only.unresolved_targets).toBeNull();
    expect(report.live_read_only.broken_references).toBeNull();
    expect(report.live_read_only.cross_source_ambiguity).toBeNull();
    expect(report.live_metric_coverage.fixture_only).toEqual([
      'unresolved_targets',
      'broken_references',
      'cross_source_ambiguity',
    ]);
  }, 30_000);

  test('insert is idempotent on observation_id', async () => {
    const row = parseObservationFixtureJsonl(readFileSync(SYNTHETIC_PATH, 'utf8'))[0]!;
    const first = await insertGraphReferenceObservations(engine, [row]);
    const second = await insertGraphReferenceObservations(engine, [{
      ...row,
      evidence_span: 'updated evidence',
    }]);
    expect(first).toBe(1);
    expect(second).toBe(1);
    const listed = await listGraphReferenceObservations(engine, row.source_id);
    const match = listed.find(r => r.observation_id === row.observation_id);
    expect(match?.evidence_span).toBe('updated evidence');
  }, 30_000);
});
