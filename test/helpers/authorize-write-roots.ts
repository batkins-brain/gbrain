/**
 * #28: write-through now requires a source to declare `write_roots` before it
 * will write anything to disk. Unset denies — being inside the source repo is
 * no longer authorization.
 *
 * Tests that exercise the write PATH (put_page write-through, brainstorm
 * --save, capture) rather than the POLICY need their fixture source to declare
 * the roots their slugs land under. That is the new contract, not a workaround:
 * a source nobody configured writes nothing, in tests exactly as in production.
 *
 * Policy behavior itself — which roots are accepted, what is refused and why —
 * is pinned in `test/write-policy.test.ts`, not here.
 */

import type { BrainEngine } from '../../src/core/engine.ts';

/**
 * Top-level slug prefixes used by the write-path fixtures across the suite.
 * Deliberately an explicit list rather than a wildcard: the policy has no
 * "allow everything" mode, and a test helper should not invent one.
 */
export const TEST_WRITE_ROOTS = [
  '.sources',
  'inbox',
  'internal',
  'meetings',
  'notes',
  'people',
  'quarantine',
  'shared',
  'wiki',
];

/** Declare `write_roots` on a fixture source so write-through is authorized. */
export async function authorizeTestWriteRoots(
  engine: BrainEngine,
  sourceId = 'default',
  roots: string[] = TEST_WRITE_ROOTS,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources SET config = $1::text::jsonb WHERE id = $2`,
    [JSON.stringify({ write_roots: roots }), sourceId],
  );
}
