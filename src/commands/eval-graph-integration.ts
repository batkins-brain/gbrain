/**
 * `gbrain eval graph-integration <fixture.jsonl> [--json] [--fixture-name <name>]`
 *
 * TAN-610 acceptance harness. Pure read-only comparison between a deterministic
 * dry-run fixture graph and a live-read-only snapshot collected from the engine.
 * No mutations, no extraction/backfill, no repair writes.
 */

import type { BrainEngine } from '../core/engine.ts';
import { readFileSync } from 'fs';
import {
  buildSnapshot,
  compareSnapshots,
  parseGraphFixtureJsonl,
  type GraphFixtureRow,
  type GraphGraphSnapshot,
  type GraphIntegrationAdapter,
  type LiveGraphEdgeRow,
  type LiveGraphNodeRow,
} from '../eval/graph-integration/harness.ts';

function help(): void {
  console.log(`Usage: gbrain eval graph-integration <fixture.jsonl> [--json] [--fixture-name <name>] [--live-read-only]

Run the TAN-610 graph/backlink acceptance harness in read-only mode.
Measures outgoing links, incoming backlinks, typed relations, unresolved targets,
broken references, duplicate edges, cross-source ambiguity, and authority-lifecycle compliance.

Options:
  --json               Emit machine-readable JSON.
  --fixture-name NAME   Label the fixture in the report.
  --live-read-only      Compare the fixture snapshot against a live engine snapshot.
`);
}

function parseArgs(args: string[]): { fixture?: string; json: boolean; fixtureName: string; liveReadOnly: boolean } {
  const json = args.includes('--json');
  const liveReadOnly = args.includes('--live-read-only');
  const fixtureNameIdx = args.indexOf('--fixture-name');
  const fixtureName = fixtureNameIdx >= 0 ? args[fixtureNameIdx + 1] ?? 'graph-integration' : 'graph-integration';
  const fixture = args.find(a => !a.startsWith('--') && a !== fixtureName);
  return { fixture, json, fixtureName, liveReadOnly };
}

async function readLiveSnapshot(engine: BrainEngine): Promise<GraphGraphSnapshot> {
  const nodes = await engine.executeRaw<LiveGraphNodeRow>(
    `SELECT slug, type, title, source_id, frontmatter FROM pages ORDER BY slug`,
    [],
  );
  const edges = await engine.executeRaw<LiveGraphEdgeRow>(
    `SELECT fp.slug AS from_slug, tp.slug AS to_slug, l.link_type,
            fp.source_id AS from_source_id, tp.source_id AS to_source_id,
            COALESCE(l.link_source, '') AS evidence
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       JOIN pages tp ON tp.id = l.to_page_id
      ORDER BY fp.slug, tp.slug, l.link_type`,
    [],
  );
  return {
    nodes: nodes.map(n => {
      const frontmatter = typeof n.frontmatter === 'string' ? JSON.parse(n.frontmatter) : (n.frontmatter ?? {});
      return {
        slug: n.slug,
        type: n.type as any,
        title: n.title,
        source_id: String((frontmatter as any).source_id ?? n.source_id ?? 'default'),
        authority_state: (frontmatter as any).authority_state,
        successor_slug: (frontmatter as any).successor_slug,
      };
    }),
    edges: edges.map(e => ({
      from: e.from_slug,
      to: e.to_slug,
      type: e.link_type as any,
      source_id: e.from_source_id,
      from_source_id: e.from_source_id,
      to_source_id: e.to_source_id,
      evidence: e.evidence ?? undefined,
    })),
  };
}

export async function runEvalGraphIntegration(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    help();
    return;
  }
  const { fixture, json, fixtureName, liveReadOnly } = parseArgs(args);
  if (!fixture) {
    console.error('Usage: gbrain eval graph-integration <fixture.jsonl> [--json] [--fixture-name <name>] [--live-read-only]');
    process.exit(2);
  }

  let rows: GraphFixtureRow[];
  try {
    rows = parseGraphFixtureJsonl(readFileSync(fixture, 'utf8'));
  } catch (e) {
    console.error(`Cannot read fixture: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const dry = buildSnapshot(rows);
  const live = liveReadOnly ? await readLiveSnapshot(engine) : null;
  const report = compareSnapshots(dry, live);
  report.fixture_name = fixtureName;

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Graph integration — ${report.fixture_name}`);
    console.log(`  coverage: dry nodes=${report.coverage.dry_run_nodes} edges=${report.coverage.dry_run_edges}${live ? ` live nodes=${report.coverage.live_read_only_nodes} edges=${report.coverage.live_read_only_edges}` : ''}`);
    if (report.live_read_only) {
      for (const row of report.comparisons) {
        const liveValue = row.live_read_only ?? 0;
        console.log(`  ${row.metric.padEnd(28)} dry=${row.dry_run} live=${liveValue} delta=${row.delta >= 0 ? '+' : ''}${row.delta}`);
      }
    } else {
      console.log('  live-read-only: omitted (fixture-only default)');
    }
    if (report.notes.length > 0) {
      console.log('\nNotes:');
      for (const note of report.notes) console.log(`  - ${note}`);
    }
  }
}
