/**
 * `gbrain eval graph-integration <fixture.jsonl> [--json] [--fixture-name <name>]`
 *
 * TAN-610 acceptance harness. Pure read-only comparison between a deterministic
 * dry-run fixture graph and a live-read-only snapshot collected from the engine.
 * No mutations, no extraction/backfill, no repair writes.
 */

import type { BrainEngine } from '../core/engine.ts';
import { readFileSync } from 'fs';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { assertValidSourceId } from '../core/source-id.ts';
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
  console.log(`Usage: gbrain eval graph-integration <fixture.jsonl> [--json] [--fixture-name <name>] [--live-read-only --source <id>]

Run the TAN-610 graph/backlink acceptance harness in read-only mode.
Measures outgoing links, incoming backlinks, typed relations, unresolved targets,
broken references, duplicate edges, cross-source ambiguity, and authority-lifecycle compliance.
Persisted live links can measure only resolved-edge metrics; unresolved targets,
broken references, and cross-source ambiguity remain fixture-only and are emitted
as null in the live result with explicit metric-coverage metadata.

Options:
  --json               Emit machine-readable JSON.
  --fixture-name NAME   Label the fixture in the report.
  --live-read-only      Compare the fixture snapshot against a live engine snapshot.
  --source ID          Required with --live-read-only; constrain live SQL to that source scope.
`);
}

function parseArgs(args: string[]): { fixture?: string; json: boolean; fixtureName: string; liveReadOnly: boolean; sourceId?: string } {
  const json = args.includes('--json');
  const liveReadOnly = args.includes('--live-read-only');
  const fixtureNameIdx = args.indexOf('--fixture-name');
  const fixtureNameValue = fixtureNameIdx >= 0 ? args[fixtureNameIdx + 1] : undefined;
  const fixtureName = fixtureNameValue && !fixtureNameValue.startsWith('--')
    ? fixtureNameValue
    : 'graph-integration';
  const sourceIdx = args.indexOf('--source');
  const sourceValue = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;
  const sourceId = sourceValue && !sourceValue.startsWith('--') ? sourceValue : undefined;
  const consumedValues = new Set<number>();
  if (fixtureNameIdx >= 0 && fixtureNameValue === fixtureName) consumedValues.add(fixtureNameIdx + 1);
  if (sourceIdx >= 0 && sourceValue === sourceId) consumedValues.add(sourceIdx + 1);
  const fixture = args.find((a, index) => !a.startsWith('--') && !consumedValues.has(index));
  return { fixture, json, fixtureName, liveReadOnly, sourceId };
}

type PreparedGraphIntegrationInput = ReturnType<typeof parseArgs> & {
  fixture: string;
  rows: GraphFixtureRow[];
};

function prepareGraphIntegrationInput(args: string[]): PreparedGraphIntegrationInput {
  const parsed = parseArgs(args);
  if (!parsed.fixture) {
    throw new Error('Usage: gbrain eval graph-integration <fixture.jsonl> [--json] [--fixture-name <name>] [--live-read-only --source <id>]');
  }
  if (parsed.liveReadOnly && !parsed.sourceId) {
    throw new Error('Missing required --source <id> when using --live-read-only.');
  }
  if (parsed.liveReadOnly) {
    assertValidSourceId(parsed.sourceId);
  }

  try {
    return {
      ...parsed,
      fixture: parsed.fixture,
      rows: parseGraphFixtureJsonl(readFileSync(parsed.fixture, 'utf8')),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid source_id:')) {
      throw error;
    }
    throw new Error(`Cannot read fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fail closed before the generic CLI connects to a brain. A live probe may
 * open an engine only after all syntax and fixture parsing that can fail
 * without the engine has succeeded.
 */
export function graphIntegrationNeedsEngine(args: string[]): boolean {
  if (args.includes('--help') || args.includes('-h')) return false;
  if (!parseArgs(args).liveReadOnly) return false;
  try {
    prepareGraphIntegrationInput(args);
    return true;
  } catch {
    return false;
  }
}

async function readLiveSnapshot(engine: BrainEngine, sourceId: string): Promise<GraphGraphSnapshot> {
  const nodes = await engine.executeRaw<LiveGraphNodeRow>(
    `SELECT p.slug, p.type, p.title, p.source_id, p.frontmatter
       FROM pages p
      WHERE p.source_id = $1
        AND p.deleted_at IS NULL
      ORDER BY p.slug`,
    [sourceId],
  );
  const edges = await engine.executeRaw<LiveGraphEdgeRow>(
    `SELECT fp.slug AS from_slug, tp.slug AS to_slug, l.link_type,
            fp.source_id AS from_source_id, tp.source_id AS to_source_id,
            COALESCE(l.link_source, '') AS evidence
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id AND fp.deleted_at IS NULL
       JOIN pages tp ON tp.id = l.to_page_id AND tp.deleted_at IS NULL
      WHERE fp.source_id = $1
      ORDER BY fp.slug, tp.slug, l.link_type`,
    [sourceId],
  );
  const scopedNodes = nodes.map(n => {
    const frontmatter = typeof n.frontmatter === 'string' ? JSON.parse(n.frontmatter) : (n.frontmatter ?? {});
    return {
      slug: n.slug,
      type: n.type as any,
      title: n.title,
      // pages.source_id is the canonical routing identity selected by the
      // source-scoped SQL predicate. Frontmatter may be stale and must not
      // move a row into another source in the in-memory graph.
      source_id: String(n.source_id ?? 'default'),
      authority_state: (frontmatter as any).authority_state,
      successor_slug: (frontmatter as any).successor_slug,
    };
  });
  const scopedKeys = new Set(scopedNodes.map(n => `${n.source_id}\u0000${n.slug}`));
  const boundaryNodes = edges
    .filter(e => !scopedKeys.has(`${e.to_source_id}\u0000${e.to_slug}`))
    .map(e => ({
      slug: e.to_slug,
      type: 'external-reference' as any,
      title: e.to_slug,
      source_id: e.to_source_id,
      authority_state: undefined,
    }));
  const uniqueBoundaryNodes = [...new Map(boundaryNodes.map(n => [`${n.source_id}\u0000${n.slug}`, n])).values()];
  return {
    // External targets are represented only by edge-derived boundary identities;
    // no out-of-scope page body, title, or frontmatter is loaded.
    nodes: [...scopedNodes, ...uniqueBoundaryNodes],
    edges: edges.map(e => ({
      from: e.from_slug,
      to: e.to_slug,
      type: e.link_type as any,
      source_id: e.from_source_id,
      from_source_id: e.from_source_id,
      to_source_id: e.to_source_id,
      evidence: e.evidence ?? undefined,
    })),
    // `links` contains only resolved FK-backed endpoints and stores explicit
    // source identities. It cannot reveal unresolved references or missing /
    // ambiguous source qualification. Those remain deterministic fixture-only
    // metrics until GBrain persists a dedicated unresolved-reference substrate.
    fixtureOnlyMetrics: [
      'unresolved_targets',
      'broken_references',
      'cross_source_ambiguity',
    ],
  };
}


export async function runEvalGraphIntegration(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    help();
    return;
  }
  let prepared: PreparedGraphIntegrationInput;
  try {
    prepared = prepareGraphIntegrationInput(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    setCliExitVerdict(2);
    return;
  }
  const { json, fixtureName, liveReadOnly, sourceId, rows } = prepared;

  const dry = buildSnapshot(rows);
  if (liveReadOnly && !engine) {
    console.error('Live read-only comparison requires a configured brain connection.');
    setCliExitVerdict(1);
    return;
  }
  const live = liveReadOnly ? await readLiveSnapshot(engine!, sourceId!) : null;
  const report = compareSnapshots(dry, live);
  report.fixture_name = fixtureName;
  report.live_source_scope = liveReadOnly ? sourceId! : null;
  if (liveReadOnly) report.notes.push(`live-read-only source scope: ${sourceId}`);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Graph integration — ${report.fixture_name}`);
    console.log(`  coverage: dry nodes=${report.coverage.dry_run_nodes} edges=${report.coverage.dry_run_edges}${live ? ` live nodes=${report.coverage.live_read_only_nodes} edges=${report.coverage.live_read_only_edges}` : ''}${report.live_source_scope ? ` source=${report.live_source_scope}` : ''}`);
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
