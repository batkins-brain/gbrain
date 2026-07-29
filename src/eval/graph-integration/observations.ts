/**
 * TAN-610 graph_reference_observations substrate.
 *
 * No-write metric substrate for live graph harness emission of:
 *   - unresolved_targets
 *   - broken_references
 *   - cross_source_ambiguity
 *
 * Observation rows may be loaded from synthetic/representative fixtures for
 * tests and later by a separately approved read-scan job. This module never
 * mutates pages or links.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { assertValidSourceId } from '../../core/source-id.ts';
import { validatePageSlug } from '../../core/operations.ts';

export const GRAPH_REFERENCE_OBSERVATIONS_TABLE = 'graph_reference_observations';

export const RESOLUTION_STATUSES = [
  'resolved',
  'unresolved',
  'ambiguous',
  'broken',
] as const;

export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export interface GraphReferenceObservation {
  observation_id: string;
  source_id: string;
  from_slug: string;
  raw_target: string;
  resolution_status: ResolutionStatus;
  to_source_id: string | null;
  to_slug: string | null;
  candidate_source_ids: string[];
  evidence_span: string | null;
  scanner_version: string;
  content_hash: string;
  observed_at: string;
}

export interface ObservationMetricCounts {
  unresolved_targets: number;
  broken_references: number;
  cross_source_ambiguity: number;
}

export const OBSERVATION_METRIC_KEYS = [
  'unresolved_targets',
  'broken_references',
  'cross_source_ambiguity',
] as const satisfies ReadonlyArray<keyof ObservationMetricCounts>;

type DbObservationRow = {
  observation_id: string;
  source_id: string;
  from_slug: string;
  raw_target: string;
  resolution_status: string;
  to_source_id: string | null;
  to_slug: string | null;
  candidate_source_ids: unknown;
  evidence_span: string | null;
  scanner_version: string;
  content_hash: string;
  observed_at: string | Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  lineNumber: number,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`observation fixture line ${lineNumber}: ${field} must be a non-empty string`);
  }
}

function validateOptionalSlug(
  value: unknown,
  field: string,
  lineNumber: number,
): string | null {
  if (value === undefined || value === null) return null;
  requireNonEmptyString(value, field, lineNumber);
  try {
    validatePageSlug(value);
  } catch (error) {
    throw new Error(
      `observation fixture line ${lineNumber}: invalid ${field}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return value;
}

function normalizeCandidateSourceIds(value: unknown, lineNumber: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`observation fixture line ${lineNumber}: candidate_source_ids must be an array`);
  }
  const out: string[] = [];
  for (const item of value) {
    try {
      assertValidSourceId(item);
    } catch (error) {
      throw new Error(
        `observation fixture line ${lineNumber}: invalid candidate_source_ids entry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    out.push(item);
  }
  return out;
}

function normalizeCandidateSourceIdsFromDb(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    try {
      return normalizeCandidateSourceIds(JSON.parse(value), 0);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function isResolutionStatus(value: unknown): value is ResolutionStatus {
  return typeof value === 'string' && (RESOLUTION_STATUSES as readonly string[]).includes(value);
}

function validateObservationRow(value: unknown, lineNumber: number): GraphReferenceObservation {
  if (!isRecord(value)) {
    throw new Error(`observation fixture line ${lineNumber}: expected a JSON object`);
  }

  requireNonEmptyString(value.observation_id, 'observation_id', lineNumber);
  try {
    assertValidSourceId(value.source_id);
  } catch (error) {
    throw new Error(
      `observation fixture line ${lineNumber}: invalid source_id: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  requireNonEmptyString(value.from_slug, 'from_slug', lineNumber);
  try {
    validatePageSlug(value.from_slug);
  } catch (error) {
    throw new Error(
      `observation fixture line ${lineNumber}: invalid from_slug: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  requireNonEmptyString(value.raw_target, 'raw_target', lineNumber);
  if (!isResolutionStatus(value.resolution_status)) {
    throw new Error(
      `observation fixture line ${lineNumber}: resolution_status must be one of ${RESOLUTION_STATUSES.join(', ')}`,
    );
  }
  requireNonEmptyString(value.scanner_version, 'scanner_version', lineNumber);
  requireNonEmptyString(value.content_hash, 'content_hash', lineNumber);

  let to_source_id: string | null = null;
  if (value.to_source_id !== undefined && value.to_source_id !== null) {
    try {
      assertValidSourceId(value.to_source_id);
      to_source_id = value.to_source_id;
    } catch (error) {
      throw new Error(
        `observation fixture line ${lineNumber}: invalid to_source_id: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const to_slug = validateOptionalSlug(value.to_slug, 'to_slug', lineNumber);
  const candidate_source_ids = normalizeCandidateSourceIds(value.candidate_source_ids, lineNumber);

  let evidence_span: string | null = null;
  if (value.evidence_span !== undefined && value.evidence_span !== null) {
    if (typeof value.evidence_span !== 'string') {
      throw new Error(`observation fixture line ${lineNumber}: evidence_span must be a string when provided`);
    }
    evidence_span = value.evidence_span;
  }

  let observed_at: string;
  if (value.observed_at === undefined || value.observed_at === null) {
    observed_at = new Date(0).toISOString();
  } else if (typeof value.observed_at === 'string' && value.observed_at.trim().length > 0) {
    const parsed = Date.parse(value.observed_at);
    if (Number.isNaN(parsed)) {
      throw new Error(`observation fixture line ${lineNumber}: observed_at must be an ISO-8601 timestamp`);
    }
    observed_at = new Date(parsed).toISOString();
  } else {
    throw new Error(`observation fixture line ${lineNumber}: observed_at must be an ISO-8601 timestamp`);
  }

  return {
    observation_id: value.observation_id,
    source_id: value.source_id,
    from_slug: value.from_slug,
    raw_target: value.raw_target,
    resolution_status: value.resolution_status,
    to_source_id,
    to_slug,
    candidate_source_ids,
    evidence_span,
    scanner_version: value.scanner_version,
    content_hash: value.content_hash,
    observed_at,
  };
}

export function parseObservationFixtureJsonl(text: string): GraphReferenceObservation[] {
  const rows: GraphReferenceObservation[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `observation fixture line ${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    rows.push(validateObservationRow(parsed, index + 1));
  }
  if (rows.length === 0) {
    throw new Error('observation fixture must contain at least one observation row');
  }
  return rows;
}

export function countObservationMetrics(rows: readonly GraphReferenceObservation[]): ObservationMetricCounts {
  let unresolved_targets = 0;
  let broken_references = 0;
  let cross_source_ambiguity = 0;
  for (const row of rows) {
    if (row.resolution_status === 'unresolved') unresolved_targets++;
    else if (row.resolution_status === 'broken') broken_references++;
    else if (row.resolution_status === 'ambiguous') cross_source_ambiguity++;
  }
  return { unresolved_targets, broken_references, cross_source_ambiguity };
}

/**
 * Derive live metric emission policy: only when at least one observation row
 * exists for the source are the three fixture-only metrics promoted to numeric
 * values. Empty substrate remains null/fixture-only (no false-zero claim that
 * a scan has run).
 */
export function observationMetricsForLiveEmission(
  rows: readonly GraphReferenceObservation[],
): ObservationMetricCounts | null {
  if (rows.length === 0) return null;
  return countObservationMetrics(rows);
}

export async function graphReferenceObservationsTableExists(engine: BrainEngine): Promise<boolean> {
  try {
    const rows = await engine.executeRaw<{ exists: boolean }>(
      `SELECT to_regclass('public.graph_reference_observations') IS NOT NULL AS exists`,
    );
    return rows[0]?.exists === true;
  } catch {
    return false;
  }
}

function mapDbRow(row: DbObservationRow): GraphReferenceObservation {
  const observedAt = row.observed_at instanceof Date
    ? row.observed_at.toISOString()
    : String(row.observed_at);
  if (!isResolutionStatus(row.resolution_status)) {
    throw new Error(`graph_reference_observations row ${row.observation_id}: invalid resolution_status`);
  }
  return {
    observation_id: row.observation_id,
    source_id: row.source_id,
    from_slug: row.from_slug,
    raw_target: row.raw_target,
    resolution_status: row.resolution_status,
    to_source_id: row.to_source_id ?? null,
    to_slug: row.to_slug ?? null,
    candidate_source_ids: normalizeCandidateSourceIdsFromDb(row.candidate_source_ids),
    evidence_span: row.evidence_span ?? null,
    scanner_version: row.scanner_version,
    content_hash: row.content_hash,
    observed_at: observedAt,
  };
}

export async function listGraphReferenceObservations(
  engine: BrainEngine,
  sourceId: string,
): Promise<GraphReferenceObservation[]> {
  assertValidSourceId(sourceId);
  const exists = await graphReferenceObservationsTableExists(engine);
  if (!exists) return [];

  const rows = await engine.executeRaw<DbObservationRow>(
    `SELECT observation_id, source_id, from_slug, raw_target, resolution_status,
            to_source_id, to_slug, candidate_source_ids, evidence_span,
            scanner_version, content_hash, observed_at
       FROM graph_reference_observations
      WHERE source_id = $1
      ORDER BY observed_at DESC, observation_id ASC`,
    [sourceId],
  );
  return rows.map(mapDbRow);
}

/**
 * Fixture/test path only: insert observation rows into a disposable engine.
 * Does not mutate pages or links. Not a production scanner.
 */
export async function insertGraphReferenceObservations(
  engine: BrainEngine,
  rows: readonly GraphReferenceObservation[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const exists = await graphReferenceObservationsTableExists(engine);
  if (!exists) {
    throw new Error(
      'graph_reference_observations table is missing; apply migrations before inserting observation fixtures',
    );
  }

  let inserted = 0;
  for (const row of rows) {
    assertValidSourceId(row.source_id);
    if (row.to_source_id) assertValidSourceId(row.to_source_id);
    await engine.executeRaw(
      `INSERT INTO graph_reference_observations (
         observation_id, source_id, from_slug, raw_target, resolution_status,
         to_source_id, to_slug, candidate_source_ids, evidence_span,
         scanner_version, content_hash, observed_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8::jsonb, $9,
         $10, $11, $12::timestamptz
       )
       ON CONFLICT (observation_id) DO UPDATE SET
         source_id = EXCLUDED.source_id,
         from_slug = EXCLUDED.from_slug,
         raw_target = EXCLUDED.raw_target,
         resolution_status = EXCLUDED.resolution_status,
         to_source_id = EXCLUDED.to_source_id,
         to_slug = EXCLUDED.to_slug,
         candidate_source_ids = EXCLUDED.candidate_source_ids,
         evidence_span = EXCLUDED.evidence_span,
         scanner_version = EXCLUDED.scanner_version,
         content_hash = EXCLUDED.content_hash,
         observed_at = EXCLUDED.observed_at`,
      [
        row.observation_id,
        row.source_id,
        row.from_slug,
        row.raw_target,
        row.resolution_status,
        row.to_source_id,
        row.to_slug,
        JSON.stringify(row.candidate_source_ids),
        row.evidence_span,
        row.scanner_version,
        row.content_hash,
        row.observed_at,
      ],
    );
    inserted++;
  }
  return inserted;
}

export async function loadObservationFixtureIntoEngine(
  engine: BrainEngine,
  fixtureText: string,
  sourceId?: string,
): Promise<{ loaded: number; metrics: ObservationMetricCounts | null }> {
  const rows = parseObservationFixtureJsonl(fixtureText);
  const scoped = sourceId ? rows.filter(r => r.source_id === sourceId) : rows;
  if (sourceId && scoped.length === 0) {
    throw new Error(`observation fixture contains no rows for source_id ${JSON.stringify(sourceId)}`);
  }
  const loaded = await insertGraphReferenceObservations(engine, scoped);
  return {
    loaded,
    metrics: observationMetricsForLiveEmission(scoped),
  };
}
