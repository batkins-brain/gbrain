/**
 * TAN-576 — ordinary unqualified search must include federated sources.
 *
 * Documented operator contract: federated sources "appear in cross-source
 * default search"; isolated sources are "only searched when explicitly named."
 * Pre-fix, query/search scoped to scalar ctx.sourceId only, so a local agent
 * querying without --source missed federated project knowledge (e.g. 24-105
 * rulings living outside source_id=default).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  resolveSearchScope,
  resolveRequestedScope,
  type OperationContext,
} from '../src/core/operations.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;

function localCtx(sourceId: string, remote = false): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote,
    sourceId,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('resolveSearchScope — TAN-576 federated ordinary path', () => {
  test('trusted local scalar default expands to include federated sources', async () => {
    await runSources(engine, ['add', 'proj-a', '--no-federated']);
    await runSources(engine, ['add', 'proj-b', '--federated']);
    await runSources(engine, ['federate', 'proj-b']);

    const scope = await resolveSearchScope(localCtx('default'), undefined);
    expect(scope.sourceId).toBeUndefined();
    expect(scope.sourceIds).toBeDefined();
    expect(scope.sourceIds!.sort()).toEqual(['default', 'proj-b'].sort());
    // Isolated proj-a must NOT appear in ordinary default search.
    expect(scope.sourceIds).not.toContain('proj-a');
  });

  test('explicit source_id stays single-source (no silent federation widen)', async () => {
    const scope = await resolveSearchScope(localCtx('default'), 'proj-a');
    expect(scope).toEqual({ sourceId: 'proj-a' });
  });

  test('explicit __all__ stays whole-brain for trusted local', async () => {
    const scope = await resolveSearchScope(localCtx('default'), '__all__');
    expect(scope).toEqual({});
  });

  test('remote scalar caller does not inherit host federation membership', async () => {
    const scope = await resolveSearchScope(localCtx('default', true), undefined);
    expect(scope).toEqual({ sourceId: 'default' });
  });

  test('remote allowedSources grant is unchanged', async () => {
    const ctx = localCtx('default', true);
    ctx.auth = { allowedSources: ['proj-a'] } as OperationContext['auth'];
    const scope = await resolveSearchScope(ctx, undefined);
    expect(scope).toEqual({ sourceIds: ['proj-a'] });
  });

  test('resolveRequestedScope remains scalar (non-search callers unchanged)', () => {
    const scope = resolveRequestedScope(localCtx('default'), undefined);
    expect(scope).toEqual({ sourceId: 'default' });
  });
});
