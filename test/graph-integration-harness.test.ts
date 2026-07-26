/**
 * TAN-610 graph/backlink acceptance harness tests.
 */

import { describe, expect, test, mock } from 'bun:test';
import { compareSnapshots, buildSnapshot, parseGraphFixtureJsonl, runGraphIntegrationHarness, type GraphFixtureRow } from '../src/eval/graph-integration/harness.ts';
import { runEvalGraphIntegration } from '../src/commands/eval-graph-integration.ts';

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

  test('--live-read-only CLI executes live readSnapshot path', async () => {
    const fixturePath = Bun.pathToFileURL('/tmp/tan610-fixture-live.jsonl').pathname;
    await Bun.write(fixturePath, FIXTURE);
    const executeRaw = mock(async (sql: string) => {
      if (sql.includes('FROM pages')) {
        return [
          { slug: 'people/alice-example', type: 'person', title: 'Alice Example', source_id: 'default', frontmatter: { source_id: 'default', authority_state: 'active' } },
          { slug: 'companies/acme-example', type: 'company', title: 'Acme Example', source_id: 'default', frontmatter: { source_id: 'default', authority_state: 'active' } },
        ];
      }
      return [
        { from_slug: 'people/alice-example', to_slug: 'companies/acme-example', link_type: 'works_at', from_source_id: 'default', to_source_id: 'default', evidence: 'live' },
      ];
    });
    const engine = { executeRaw } as any;
    const log = mock(() => {});
    const originalLog = console.log;
    console.log = log as any;
    try {
      await runEvalGraphIntegration(engine, [fixturePath, '--live-read-only']);
    } finally {
      console.log = originalLog;
    }
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join('\n')).toContain('coverage: dry nodes=');
    expect(log.mock.calls.flat().join('\n')).not.toContain('fixture-only default');
  });
});
