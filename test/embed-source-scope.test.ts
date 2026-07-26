import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runEmbed } from '../src/commands/embed.ts';

let engine: PGLiteEngine;
let originalSource: string | undefined;

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as never;
  console.log = (...args: unknown[]) => {
    captured += args.map((arg) => String(arg)).join(' ') + '\n';
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    process.stdout.write = original;
  }
  return captured;
}

beforeAll(async () => {
  originalSource = process.env.GBRAIN_SOURCE;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  if (originalSource === undefined) delete process.env.GBRAIN_SOURCE;
  else process.env.GBRAIN_SOURCE = originalSource;
  await engine.disconnect();
});

beforeEach(async () => {
  delete process.env.GBRAIN_SOURCE;
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM sources WHERE id != 'default'`);
});

describe('embed source scoping', () => {
  test('GBRAIN_SOURCE scopes stale dry-run count and names the source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('tf-brain-live-vault', 'tf-brain-live-vault', '{"federated":false}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await engine.putPage('default-page', { type: 'note', title: 'Default', compiled_truth: 'default body' });
    await engine.putPage(
      'vault-page',
      { type: 'note', title: 'Vault', compiled_truth: 'vault body' },
      { sourceId: 'tf-brain-live-vault' },
    );
    await engine.upsertChunks('default-page', [
      { chunk_index: 0, chunk_text: 'default one', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'default two', chunk_source: 'compiled_truth' },
    ]);
    await engine.upsertChunks('vault-page', [
      { chunk_index: 0, chunk_text: 'vault one', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'vault two', chunk_source: 'compiled_truth' },
      { chunk_index: 2, chunk_text: 'vault three', chunk_source: 'compiled_truth' },
    ], { sourceId: 'tf-brain-live-vault' });

    process.env.GBRAIN_SOURCE = 'tf-brain-live-vault';
    const scoped = await captureStdout(() => runEmbed(engine, ['--stale', '--dry-run']));
    delete process.env.GBRAIN_SOURCE;
    const unscoped = await captureStdout(() => runEmbed(engine, ['--stale', '--dry-run']));

    expect(scoped).toContain('[dry-run] Would embed 3 stale chunks in source tf-brain-live-vault');
    expect(unscoped).toContain('[dry-run] Would embed 5 stale chunks');
    expect(unscoped).not.toContain('in source tf-brain-live-vault');
  });

  test('explicit source scopes all dry-run output', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('tf-brain-live-vault', 'tf-brain-live-vault', '{"federated":false}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    await engine.putPage(
      'vault-page',
      { type: 'note', title: 'Vault', compiled_truth: 'vault body' },
      { sourceId: 'tf-brain-live-vault' },
    );
    const scoped = await captureStdout(() =>
      runEmbed(engine, ['--all', '--dry-run', '--source=tf-brain-live-vault']),
    );
    expect(scoped).toContain('across 1 pages in source tf-brain-live-vault');
  });

  test('missing source values fail closed', async () => {
    await expect(runEmbed(engine, ['--stale', '--source'])).rejects.toThrow('Missing value for --source');
    await expect(runEmbed(engine, ['--stale', '--source='])).rejects.toThrow('Missing value for --source');
  });
});
