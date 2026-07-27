/**
 * TAN-610 graph/backlink acceptance harness.
 *
 * Pure read-only scoring over deterministic graph fixtures. Measures:
 *   - valid outgoing links
 *   - incoming backlinks
 *   - typed relations
 *   - unresolved targets
 *   - broken references
 *   - duplicate edges
 *   - cross-source ambiguity
 *   - authority-lifecycle compliance
 *
 * The harness supports two views:
 *   1. dry-run: evaluate the expected graph from fixture rows only.
 *   2. live-read-only: evaluate the graph as currently stored in the engine.
 *
 * It never mutates the DB and it does not run extraction/backfill.
 */

import { assertValidSourceId } from '../../core/source-id.ts';

export type GraphRelationType =
  | 'works_at'
  | 'advises'
  | 'invested_in'
  | 'attended'
  | 'mentions'
  | 'source'
  | 'successor_of';

export interface GraphFixtureNode {
  slug: string;
  type: 'person' | 'company' | 'project' | 'advisor' | 'archive' | 'source';
  title: string;
  source_id: string;
  authority_state?: 'active' | 'archived' | 'retired';
  successor_slug?: string;
}

export interface GraphFixtureEdge {
  from: string;
  to: string;
  type: GraphRelationType;
  /** Provenance/source scope for same-source edges. */
  source_id: string;
  /** Explicit endpoint scopes for legitimate cross-source edges. */
  from_source_id?: string;
  to_source_id?: string;
  evidence?: string;
}

export interface GraphFixtureRow {
  kind: 'node' | 'edge';
  node?: GraphFixtureNode;
  edge?: GraphFixtureEdge;
}

export interface GraphGraphEdge extends GraphFixtureEdge {
  from_type?: GraphFixtureNode['type'];
  to_type?: GraphFixtureNode['type'];
}

export interface GraphGraphSnapshot {
  nodes: GraphFixtureNode[];
  edges: GraphGraphEdge[];
  /**
   * Metrics that cannot be observed from this snapshot's backing store.
   * The persisted links table contains only resolved FK edges, so database
   * snapshots mark unresolved/broken/ambiguity metrics as fixture-only.
   */
  fixtureOnlyMetrics?: Array<keyof GraphMetricCounts>;
}

export interface GraphMetricCounts {
  valid_outgoing: number;
  incoming_backlinks: number;
  typed_relations: number;
  unresolved_targets: number;
  broken_references: number;
  duplicate_edges: number;
  cross_source_ambiguity: number;
  authority_lifecycle_compliance: number;
}

export interface GraphComparison {
  metric: keyof GraphMetricCounts;
  dry_run: number;
  live_read_only: number;
  delta: number;
}

export type GraphLiveMetricCounts = {
  [K in keyof GraphMetricCounts]: number | null;
};

export interface GraphIntegrationReport {
  schema_version: 1;
  fixture_name: string;
  live_source_scope?: string | null;
  dry_run: GraphMetricCounts;
  live_read_only?: GraphLiveMetricCounts | null;
  live_metric_coverage?: {
    measured: Array<keyof GraphMetricCounts>;
    fixture_only: Array<keyof GraphMetricCounts>;
  } | null;
  comparisons: GraphComparison[];
  coverage: {
    dry_run_edges: number;
    live_read_only_edges?: number;
    dry_run_nodes: number;
    live_read_only_nodes?: number;
  };
  notes: string[];
}

export interface GraphIntegrationAdapter {
  readSnapshot(sourceId?: string): Promise<GraphGraphSnapshot>;
}

export interface LiveGraphNodeRow {
  slug: string;
  type: string;
  title: string;
  source_id: string;
  frontmatter?: string | Record<string, unknown> | null;
}

export interface LiveGraphEdgeRow {
  from_slug: string;
  to_slug: string;
  link_type: string;
  from_source_id: string;
  to_source_id: string;
  evidence?: string | null;
}

const GRAPH_NODE_TYPES = new Set<GraphFixtureNode['type']>([
  'person',
  'company',
  'project',
  'advisor',
  'archive',
  'source',
]);
const AUTHORITY_STATES = new Set<NonNullable<GraphFixtureNode['authority_state']>>([
  'active',
  'archived',
  'retired',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  lineNumber: number,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`graph fixture line ${lineNumber}: ${field} must be a non-empty string`);
  }
}

function validateFixtureSourceId(value: unknown, field: string, lineNumber: number): asserts value is string {
  try {
    assertValidSourceId(value);
  } catch (error) {
    throw new Error(
      `graph fixture line ${lineNumber}: invalid ${field}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateFixtureRow(value: unknown, lineNumber: number): GraphFixtureRow {
  if (!isRecord(value)) {
    throw new Error(`graph fixture line ${lineNumber}: expected a JSON object`);
  }

  if (value.kind === 'node') {
    if (!isRecord(value.node)) {
      throw new Error(`graph fixture line ${lineNumber}: node row requires a node object`);
    }
    const node = value.node;
    requireNonEmptyString(node.slug, 'node.slug', lineNumber);
    requireNonEmptyString(node.title, 'node.title', lineNumber);
    requireNonEmptyString(node.type, 'node.type', lineNumber);
    if (!GRAPH_NODE_TYPES.has(node.type as GraphFixtureNode['type'])) {
      throw new Error(`graph fixture line ${lineNumber}: unsupported node.type ${JSON.stringify(node.type)}`);
    }
    validateFixtureSourceId(node.source_id, 'node.source_id', lineNumber);
    if (node.authority_state !== undefined && !AUTHORITY_STATES.has(node.authority_state as NonNullable<GraphFixtureNode['authority_state']>)) {
      throw new Error(`graph fixture line ${lineNumber}: unsupported node.authority_state ${JSON.stringify(node.authority_state)}`);
    }
    if (node.successor_slug !== undefined) {
      requireNonEmptyString(node.successor_slug, 'node.successor_slug', lineNumber);
    }
    return value as unknown as GraphFixtureRow;
  }

  if (value.kind === 'edge') {
    if (!isRecord(value.edge)) {
      throw new Error(`graph fixture line ${lineNumber}: edge row requires an edge object`);
    }
    const edge = value.edge;
    requireNonEmptyString(edge.from, 'edge.from', lineNumber);
    requireNonEmptyString(edge.to, 'edge.to', lineNumber);
    requireNonEmptyString(edge.type, 'edge.type', lineNumber);
    validateFixtureSourceId(edge.source_id, 'edge.source_id', lineNumber);
    if (edge.from_source_id !== undefined) {
      validateFixtureSourceId(edge.from_source_id, 'edge.from_source_id', lineNumber);
    }
    if (edge.to_source_id !== undefined) {
      validateFixtureSourceId(edge.to_source_id, 'edge.to_source_id', lineNumber);
    }
    if (edge.evidence !== undefined && typeof edge.evidence !== 'string') {
      throw new Error(`graph fixture line ${lineNumber}: edge.evidence must be a string when provided`);
    }
    return value as unknown as GraphFixtureRow;
  }

  throw new Error(`graph fixture line ${lineNumber}: kind must be "node" or "edge"`);
}

export function parseGraphFixtureJsonl(text: string): GraphFixtureRow[] {
  const rows: GraphFixtureRow[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `graph fixture line ${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    rows.push(validateFixtureRow(parsed, index + 1));
  }
  if (rows.length === 0) {
    throw new Error('graph fixture must contain at least one node or edge row');
  }
  return rows;
}

export function buildSnapshot(rows: GraphFixtureRow[]): GraphGraphSnapshot {
  const nodes: GraphFixtureNode[] = [];
  const edges: GraphGraphEdge[] = [];
  for (const row of rows) {
    if (row.kind === 'node' && row.node) nodes.push(row.node);
    if (row.kind === 'edge' && row.edge) edges.push(row.edge);
  }
  return { nodes, edges };
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function metricCounts(snapshot: GraphGraphSnapshot): GraphMetricCounts {
  const nodesBySlug = new Map<string, GraphFixtureNode[]>();
  const sourceScopedNodes = new Map<string, Map<string, GraphFixtureNode>>();
  for (const node of snapshot.nodes) {
    const candidates = nodesBySlug.get(node.slug) ?? [];
    candidates.push(node);
    nodesBySlug.set(node.slug, candidates);
    const perSource = sourceScopedNodes.get(node.source_id) ?? new Map<string, GraphFixtureNode>();
    perSource.set(node.slug, node);
    sourceScopedNodes.set(node.source_id, perSource);
  }

  const edgeCounts = countBy(
    snapshot.edges,
    e => `${e.from_source_id ?? e.source_id}|${e.from}|${e.to_source_id ?? e.source_id}|${e.to}|${e.type}`,
  );
  const duplicate_edges = [...edgeCounts.values()].filter(c => c > 1).reduce((sum, c) => sum + (c - 1), 0);

  let valid_outgoing = 0;
  let incoming_backlinks = 0;
  let typed_relations = 0;
  let unresolved_targets = 0;
  let broken_references = 0;
  let cross_source_ambiguity = 0;
  let authority_lifecycle_compliance = 0;

  for (const edge of snapshot.edges) {
    const fromSource = edge.from_source_id ?? edge.source_id;
    const toSource = edge.to_source_id ?? edge.source_id;
    const fromCandidates = nodesBySlug.get(edge.from) ?? [];
    const toCandidates = nodesBySlug.get(edge.to) ?? [];
    const fromScoped = sourceScopedNodes.get(fromSource)?.get(edge.from);
    const toScoped = sourceScopedNodes.get(toSource)?.get(edge.to);
    const resolved = !!fromScoped && !!toScoped;

    if (resolved) {
      valid_outgoing++;
      incoming_backlinks++;
      // GBrain permits custom relation names, so "typed" means a
      // non-empty normalized link_type rather than membership in a closed
      // enum. Blank/default link_type rows are resolved links, not typed
      // relations.
      if (typeof edge.type === 'string' && edge.type.trim().length > 0) {
        typed_relations++;
      }
    } else {
      unresolved_targets++;
      broken_references++;
    }

    // `source_id` supplies the default scope for both endpoints, so a slug
    // duplicated in another source is still unambiguous when it resolves in
    // that default scope. Ambiguity exists only when the selected endpoint
    // scope has no match while at least one other source does.
    const ambiguousQualification =
      (!fromScoped && fromCandidates.length > 0)
      || (!toScoped && toCandidates.length > 0);
    if (ambiguousQualification) cross_source_ambiguity++;

    if (fromScoped?.authority_state === 'archived' && fromScoped.successor_slug) {
      if (toScoped?.slug === fromScoped.successor_slug && toScoped.source_id === fromScoped.source_id) {
        authority_lifecycle_compliance++;
      }
    } else if (resolved && fromScoped?.authority_state === 'active') {
      authority_lifecycle_compliance++;
    }
  }

  return {
    valid_outgoing,
    incoming_backlinks,
    typed_relations,
    unresolved_targets,
    broken_references,
    duplicate_edges,
    cross_source_ambiguity,
    authority_lifecycle_compliance,
  };
}

export function compareSnapshots(dryRun: GraphGraphSnapshot, live?: GraphGraphSnapshot | null): GraphIntegrationReport {
  const dry = metricCounts(dryRun);
  const hasLive = !!live;
  const liveCounts = live ? metricCounts(live) : null;
  const metrics = Object.keys(dry) as (keyof GraphMetricCounts)[];
  const fixtureOnly = new Set(live?.fixtureOnlyMetrics ?? []);
  const measured = hasLive ? metrics.filter(metric => !fixtureOnly.has(metric)) : [];
  const liveValues: GraphLiveMetricCounts | null = liveCounts
    ? Object.fromEntries(
        metrics.map(metric => [metric, fixtureOnly.has(metric) ? null : liveCounts[metric]]),
      ) as GraphLiveMetricCounts
    : null;
  const comparisons: GraphComparison[] = hasLive
    ? measured.map(metric => ({
        metric,
        dry_run: dry[metric],
        live_read_only: liveCounts![metric],
        delta: liveCounts![metric] - dry[metric],
      }))
    : [];

  const notes: string[] = [];
  if (!hasLive) {
    notes.push('fixture-only report: live-read-only comparison omitted by default; pass --live-read-only to compare against the engine');
  } else {
    if (fixtureOnly.size > 0) {
      notes.push(
        `fixture-only metrics omitted from live comparison: ${[...fixtureOnly].join(', ')}; `
        + 'the persisted links table contains only resolved, source-qualified foreign-key edges',
      );
    }
    if (!fixtureOnly.has('broken_references') && liveCounts!.broken_references > dry.broken_references) {
      notes.push('live-read-only view contains additional broken references that a later repair would reduce');
    }
    if (!fixtureOnly.has('unresolved_targets') && liveCounts!.unresolved_targets > dry.unresolved_targets) {
      notes.push('live-read-only view contains more unresolved targets than the dry-run expectation');
    }
    if (liveCounts!.authority_lifecycle_compliance < dry.authority_lifecycle_compliance) {
      notes.push('live-read-only authority lifecycle coverage trails the dry-run fixture');
    }
  }

  return {
    schema_version: 1,
    fixture_name: 'graph-integration',
    dry_run: dry,
    live_read_only: liveValues,
    live_metric_coverage: hasLive
      ? { measured, fixture_only: [...fixtureOnly] }
      : null,
    comparisons,
    coverage: {
      dry_run_edges: dryRun.edges.length,
      dry_run_nodes: dryRun.nodes.length,
      ...(live ? { live_read_only_edges: live.edges.length, live_read_only_nodes: live.nodes.length } : {}),
    },
    notes,
  };
}

export async function runGraphIntegrationHarness(
  fixtureRows: GraphFixtureRow[],
  adapter: GraphIntegrationAdapter,
  sourceId?: string,
): Promise<GraphIntegrationReport> {
  const dry = buildSnapshot(fixtureRows);
  const live = await adapter.readSnapshot(sourceId);
  const report = compareSnapshots(dry, live);
  report.live_source_scope = sourceId ?? null;
  if (sourceId) report.notes.push(`live-read-only source scope: ${sourceId}`);
  return report;
}
