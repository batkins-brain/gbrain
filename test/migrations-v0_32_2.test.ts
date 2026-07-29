/**
 * v0.32.2 — migration orchestrator tests.
 *
 * Covers phaseASchema (asserts v51 ran), phaseBFenceFacts (legacy
 * row → fence backfill happy path, idempotent re-run, dry-run, NULL
 * entity_slug skip, missing local_path skip), and phaseCVerify
 * (mismatch detection).
 *
 * Real PGLite + real tempdir filesystem. Engine injected via
 * __setTestEngineOverride so we don't need a configured brain.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { v0_32_2, __setTestEngineOverride, __testing } from '../src/commands/migrations/v0_32_2.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setTestEngineOverride(engine);
});

afterAll(async () => {
  __setTestEngineOverride(null);
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const DRY_OPTS = { ...OPTS, dryRun: true };

async function seedLegacyFact(input: {
  entity_slug: string | null;
  fact: string;
  source_id?: string;
  visibility?: 'private' | 'world';
  notability?: 'high' | 'medium' | 'low';
  kind?: 'event' | 'preference' | 'commitment' | 'belief' | 'fact';
  source?: string;
  confidence?: number;
  context?: string | null;
  valid_from?: string;
  valid_until?: string | null;
}): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, valid_until, source, confidence, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.source_id ?? 'default',
      input.entity_slug,
      input.fact,
      input.kind ?? 'fact',
      input.visibility ?? 'private',
      input.notability ?? 'medium',
      input.valid_from ?? '2026-07-29',
      input.valid_until ?? null,
      input.source ?? 'mcp:put_page',
      input.confidence ?? 1.0,
      input.context ?? null,
    ],
  );
  return r.rows[0].id;
}

function writeEntityPage(slug: string): void {
  const path = join(brainDir, `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const title = slug.split('/').at(-1) ?? slug;
  writeFileSync(
    path,
    `---\ntype: concept\ntitle: ${title}\nslug: ${slug}\n---\n\n# ${title}\n`,
    'utf-8',
  );
}

describe('phaseASchema', () => {
  test('passes when schema is at v51', async () => {
    // initSchema ran v51, so the version config + columns are set.
    const r = await __testing.phaseASchema(engine, OPTS);
    expect(r.status).toBe('complete');
  });

  test('skipped under dry-run', async () => {
    const r = await __testing.phaseASchema(engine, DRY_OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('dry-run');
  });

  test('skipped when no engine is available', async () => {
    const r = await __testing.phaseASchema(null, OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('no_brain_configured');
  });
});

describe('phaseBFenceFacts — dry-run reporting', () => {
  test('reports counts without writing FS or updating DB', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });
    await seedLegacyFact({ entity_slug: 'people/bob', fact: 'Met at YC W22' });
    await seedLegacyFact({ entity_slug: null, fact: 'Unparented claim' });

    const r = await __testing.phaseBFenceFacts(engine, DRY_OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('dry-run');
    expect(r.detail).toContain('would_fence=2');
    expect(r.detail).toContain('targets=2');
    expect(r.detail).toContain('would_create=2');
    expect(r.detail).toContain('quarantine=2');
    expect(r.detail).toContain('unfenceable=1');

    // No files created.
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false);
    // DB rows still have NULL row_num.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num FROM facts WHERE entity_slug IS NOT NULL',
    );
    expect(rows.rows.every((r: { row_num: number | null }) => r.row_num === null)).toBe(true);
  });
});

describe('phaseBFenceFacts — happy path backfill', () => {
  test('fences legacy DB rows into entity pages + updates row_num', async () => {
    writeEntityPage('people/alice');
    const id1 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme in 2017' });
    const id2 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Prefers async over meetings' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=2');
    expect(r.detail).toContain('pages=1');

    // Existing page is preserved and receives fence content.
    const filePath = join(brainDir, 'people/alice.md');
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('## Facts');
    expect(body).toContain('Founded Acme in 2017');
    expect(body).toContain('Prefers async over meetings');

    // DB rows now have row_num + source_markdown_slug populated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT id, row_num, source_markdown_slug FROM facts ORDER BY id',
    );
    expect(rows.rows[0]).toMatchObject({ id: id1, row_num: 1, source_markdown_slug: 'people/alice' });
    expect(rows.rows[1]).toMatchObject({ id: id2, row_num: 2, source_markdown_slug: 'people/alice' });
  });

  test('groups by entity page — multi-entity batch touches multiple files', async () => {
    writeEntityPage('people/alice');
    writeEntityPage('companies/acme');
    writeEntityPage('deals/seed');
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'A1' });
    await seedLegacyFact({ entity_slug: 'companies/acme', fact: 'C1' });
    await seedLegacyFact({ entity_slug: 'deals/seed', fact: 'D1' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=3');
    expect(r.detail).toContain('pages=3');

    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'companies/acme.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'deals/seed.md'))).toBe(true);
  });

  test('appends to existing entity page without overwriting body', async () => {
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    writeFileSync(
      join(brainDir, 'people/alice.md'),
      '---\ntype: person\ntitle: Alice\nslug: people/alice\n---\n\n# Alice\n\nNotes about Alice.\n',
      'utf-8',
    );
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    await __testing.phaseBFenceFacts(engine, OPTS);

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('Notes about Alice.');  // preserved
    expect(body).toContain('## Facts');
    expect(body).toContain('Founded Acme');
  });

  test('idempotent: re-running after partial completion does NOT duplicate rows', async () => {
    writeEntityPage('people/alice');
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'First' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Second' });

    await __testing.phaseBFenceFacts(engine, OPTS);

    // Manually clear one row's row_num to simulate a partial state.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL
       WHERE fact = 'Second'`,
    );

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');

    // The re-run should reuse the existing row_num=2 (matched by claim
    // content) rather than appending a new row_num=3.
    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    const parsed = parseFactsFence(body);
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts.map(f => f.claim).sort()).toEqual(['First', 'Second']);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num FROM facts WHERE row_num IS NOT NULL ORDER BY row_num',
    );
    expect(rows.rows.map((r: { row_num: number }) => r.row_num)).toEqual([1, 2]);
  });

  test('preserves duplicate claims as distinct rows when metadata differs', async () => {
    writeEntityPage('people/alice');
    const privateId = await seedLegacyFact({
      entity_slug: 'people/alice',
      fact: 'Shared claim',
      visibility: 'private',
      confidence: 0.75,
    });
    const worldId = await seedLegacyFact({
      entity_slug: 'people/alice',
      fact: 'Shared claim',
      visibility: 'world',
      confidence: 0.9,
    });

    const result = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(result.status).toBe('complete');
    const parsed = parseFactsFence(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8'));
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts.map(f => f.visibility)).toEqual(['private', 'world']);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT id, row_num FROM facts ORDER BY id',
    );
    expect(rows.rows).toEqual([
      { id: privateId, row_num: 1 },
      { id: worldId, row_num: 2 },
    ]);
  });

  test('partial recovery consumes identical duplicate fence rows one-to-one', async () => {
    writeEntityPage('people/alice');
    const firstId = await seedLegacyFact({
      entity_slug: 'people/alice',
      fact: 'Exact duplicate',
    });
    const secondId = await seedLegacyFact({
      entity_slug: 'people/alice',
      fact: 'Exact duplicate',
    });
    await __testing.phaseBFenceFacts(engine, OPTS);

    // Simulate a crash after the fence was published and after only the first
    // DB row was stamped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL WHERE id = $1`,
      [secondId],
    );

    const result = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(result.status).toBe('complete');
    const parsed = parseFactsFence(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8'));
    expect(parsed.facts.map(f => [f.rowNum, f.claim])).toEqual([
      [1, 'Exact duplicate'],
      [2, 'Exact duplicate'],
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT id, row_num FROM facts ORDER BY id',
    );
    expect(rows.rows).toEqual([
      { id: firstId, row_num: 1 },
      { id: secondId, row_num: 2 },
    ]);
  });

  test('skips facts with NULL entity_slug (unfenceable)', async () => {
    writeEntityPage('people/alice');
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Fenceable' });
    await seedLegacyFact({ entity_slug: null, fact: 'Unfenceable' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=1');
    expect(r.detail).toContain('skipped_no_entity=1');

    // The unparented fact's row_num remains NULL.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT entity_slug, row_num FROM facts ORDER BY id`,
    );
    expect(rows.rows[0]).toMatchObject({ entity_slug: 'people/alice', row_num: 1 });
    expect(rows.rows[1]).toMatchObject({ entity_slug: null, row_num: null });
  });

  test('skips when source has no local_path', async () => {
    // Wipe default source's local_path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Whatever' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('skipped_no_local_path=1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT row_num FROM facts');
    expect(rows.rows[0].row_num).toBeNull();
  });

  test('routes a missing legacy target into deterministic private quarantine', async () => {
    const id = await seedLegacyFact({
      entity_slug: 'flattened-private-identifier',
      fact: 'Preserve this legacy claim',
    });

    const { manifest } = await __testing.buildTargetPlan(engine);
    expect(manifest).toMatchObject({
      legacy_rows: 1,
      target_count: 1,
      would_create_count: 1,
      quarantine_count: 1,
    });
    const target = manifest.targets[0];
    expect(target.disposition).toBe('quarantine');
    expect(target.reason).toBe('missing_target');
    expect(target.target_markdown_slug).toMatch(/^quarantine\/migrations\/v0-32-2\/[0-9a-f]{16}$/);
    expect(target.target_markdown_slug).not.toContain('private');
    expect(target.fact_ids).toEqual([String(id)]);

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(existsSync(join(brainDir, 'flattened-private-identifier.md'))).toBe(false);
    const quarantinePath = join(brainDir, `${target.target_markdown_slug}.md`);
    expect(existsSync(quarantinePath)).toBe(true);
    expect(readFileSync(quarantinePath, 'utf-8')).toContain('visibility: private');
    expect(readFileSync(quarantinePath, 'utf-8')).toContain(
      'gbrain_migration_owner: v0.32.2',
    );
    expect(readFileSync(quarantinePath, 'utf-8')).toContain(
      `gbrain_migration_target_sha256: ${
        __testing.migrationTargetFingerprint('default', 'flattened-private-identifier')
      }`,
    );
    expect(readFileSync(quarantinePath, 'utf-8')).toContain('Preserve this legacy claim');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT entity_slug, source_markdown_slug, row_num FROM facts WHERE id = $1',
      [id],
    );
    expect(rows.rows[0]).toMatchObject({
      entity_slug: 'flattened-private-identifier',
      source_markdown_slug: target.target_markdown_slug,
      row_num: 1,
    });
  });

  test('does not follow an existing target symlink outside the local source', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-outside-'));
    const outsidePath = join(outsideDir, 'private.md');
    writeFileSync(outsidePath, 'EXTERNAL PRIVATE CONTENT\n', 'utf-8');
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    symlinkSync(outsidePath, join(brainDir, 'people/alice.md'));

    try {
      await seedLegacyFact({
        entity_slug: 'people/alice',
        fact: 'Preserve only this legacy claim',
      });

      const { manifest } = await __testing.buildTargetPlan(engine);
      expect(manifest.targets[0]).toMatchObject({
        original_entity_slug: 'people/alice',
        disposition: 'quarantine',
        reason: 'unsafe_target',
      });

      const r = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(r.status).toBe('complete');
      expect(readFileSync(outsidePath, 'utf-8')).toBe('EXTERNAL PRIVATE CONTENT\n');

      const quarantinePath = join(
        brainDir,
        `${manifest.targets[0].target_markdown_slug}.md`,
      );
      const quarantined = readFileSync(quarantinePath, 'utf-8');
      expect(quarantined).toContain('Preserve only this legacy claim');
      expect(quarantined).not.toContain('EXTERNAL PRIVATE CONTENT');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('does not follow an intermediate directory symlink outside the local source', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-outside-dir-'));
    const outsidePath = join(outsideDir, 'alice.md');
    writeFileSync(outsidePath, 'EXTERNAL PRIVATE CONTENT\n', 'utf-8');
    symlinkSync(outsideDir, join(brainDir, 'people'));

    try {
      await seedLegacyFact({
        entity_slug: 'people/alice',
        fact: 'Preserve only this legacy claim',
      });

      const { manifest } = await __testing.buildTargetPlan(engine);
      expect(manifest.targets[0]).toMatchObject({
        original_entity_slug: 'people/alice',
        disposition: 'quarantine',
        reason: 'unsafe_target',
      });

      const r = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(r.status).toBe('complete');
      expect(readFileSync(outsidePath, 'utf-8')).toBe('EXTERNAL PRIVATE CONTENT\n');

      const quarantinePath = join(
        brainDir,
        `${manifest.targets[0].target_markdown_slug}.md`,
      );
      const quarantined = readFileSync(quarantinePath, 'utf-8');
      expect(quarantined).toContain('Preserve only this legacy claim');
      expect(quarantined).not.toContain('EXTERNAL PRIVATE CONTENT');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('rejects an intermediate directory symlink even when it stays inside the source', async () => {
    const redirectedDir = join(brainDir, 'redirected-people');
    const redirectedPath = join(redirectedDir, 'alice.md');
    mkdirSync(redirectedDir, { recursive: true });
    writeFileSync(redirectedPath, 'IN-ROOT UNRELATED CONTENT\n', 'utf-8');
    symlinkSync(redirectedDir, join(brainDir, 'people'));

    await seedLegacyFact({
      entity_slug: 'people/alice',
      fact: 'Preserve only this legacy claim',
    });

    const { manifest } = await __testing.buildTargetPlan(engine);
    expect(manifest.targets[0]).toMatchObject({
      original_entity_slug: 'people/alice',
      disposition: 'quarantine',
      reason: 'unsafe_target',
    });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(readFileSync(redirectedPath, 'utf-8')).toBe('IN-ROOT UNRELATED CONTENT\n');
  });

  test('fails closed when an in-root quarantine directory component is a symlink', async () => {
    mkdirSync(join(brainDir, 'redirected-quarantine'), { recursive: true });
    symlinkSync(join(brainDir, 'redirected-quarantine'), join(brainDir, 'quarantine'));
    await seedLegacyFact({
      entity_slug: 'missing-private-identifier',
      fact: 'Must not be redirected',
    });

    await expect(__testing.buildTargetPlan(engine)).rejects.toThrow(/quarantine target/);
    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(existsSync(join(brainDir, 'redirected-quarantine', 'migrations'))).toBe(false);
  });

  test('fails closed when an out-of-root quarantine directory component is a symlink', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-quarantine-outside-'));
    symlinkSync(outsideDir, join(brainDir, 'quarantine'));
    try {
      await seedLegacyFact({
        entity_slug: 'missing-private-identifier',
        fact: 'Must not escape',
      });

      await expect(__testing.buildTargetPlan(engine)).rejects.toThrow(/quarantine target/);
      const r = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(r.status).toBe('failed');
      expect(existsSync(join(outsideDir, 'migrations'))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('rejects a clean unrelated file at a deterministic quarantine destination', async () => {
    await seedLegacyFact({
      entity_slug: 'missing-private-identifier',
      fact: 'Must not replace unrelated content',
    });
    const slug = __testing.quarantineSlug('default', 'missing-private-identifier');
    const collisionPath = join(brainDir, `${slug}.md`);
    mkdirSync(dirname(collisionPath), { recursive: true });
    writeFileSync(collisionPath, 'UNRELATED CLEAN CONTENT\n');
    execFileSync('git', ['init', '-q', brainDir]);
    execFileSync('git', ['-C', brainDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', brainDir, 'config', 'user.name', 'test']);
    execFileSync('git', ['-C', brainDir, 'add', '.']);
    execFileSync('git', ['-C', brainDir, 'commit', '-qm', 'baseline']);

    await expect(__testing.buildTargetPlan(engine)).rejects.toThrow(
      /not owned by migration v0\.32\.2/,
    );
    const result = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(result.status).toBe('failed');
    expect(readFileSync(collisionPath, 'utf-8')).toBe('UNRELATED CLEAN CONTENT\n');
  });

  test('accepts an owned quarantine destination during partial recovery', async () => {
    const id = await seedLegacyFact({
      entity_slug: 'missing-private-identifier',
      fact: 'Recover this quarantined fact',
    });
    const first = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(first.status).toBe('complete');
    const slug = __testing.quarantineSlug('default', 'missing-private-identifier');
    const path = join(brainDir, `${slug}.md`);
    const before = readFileSync(path, 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET row_num = NULL, source_markdown_slug = NULL WHERE id = $1`,
      [id],
    );
    const second = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(second.status).toBe('complete');
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  test('owned temporary writes reject in-root and out-of-root symlinks', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-tmp-outside-'));
    const inRootVictim = join(brainDir, 'in-root-victim.md');
    const outsideVictim = join(outsideDir, 'outside-victim.md');
    writeFileSync(inRootVictim, 'IN ROOT\n');
    writeFileSync(outsideVictim, 'OUTSIDE\n');
    const inRootLink = join(brainDir, 'in-root-link.tmp');
    const outsideLink = join(brainDir, 'outside-link.tmp');
    symlinkSync(inRootVictim, inRootLink);
    symlinkSync(outsideVictim, outsideLink);

    const parent = __testing.openAnchoredParent(brainDir, inRootLink, false);
    try {
      expect(() => __testing.writeOwnedTempFileAt(parent, 'in-root-link.tmp', 'overwrite')).toThrow();
      expect(() => __testing.writeOwnedTempFileAt(parent, 'outside-link.tmp', 'overwrite')).toThrow();
      expect(readFileSync(inRootVictim, 'utf-8')).toBe('IN ROOT\n');
      expect(readFileSync(outsideVictim, 'utf-8')).toBe('OUTSIDE\n');
    } finally {
      __testing.closeAnchoredParent(parent);
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('descriptor-anchored write and rename cannot follow a swapped parent path', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-race-outside-'));
    const peopleDir = join(brainDir, 'people');
    const movedPeopleDir = join(brainDir, 'people-before-swap');
    mkdirSync(peopleDir, { recursive: true });
    writeFileSync(join(peopleDir, 'alice.md'), 'ORIGINAL\n');
    writeFileSync(join(outsideDir, 'alice.md'), 'OUTSIDE\n');

    const target = join(peopleDir, 'alice.md');
    const parent = __testing.openAnchoredParent(brainDir, target, false);
    try {
      // Swap the pathname after the trusted directory descriptor is open.
      renameSync(peopleDir, movedPeopleDir);
      symlinkSync(outsideDir, peopleDir);

      __testing.writeOwnedTempFileAt(parent, '.migration.tmp', 'PRIVATE\n');
      renameSync(
        __testing.anchoredChildPath(parent, '.migration.tmp'),
        __testing.anchoredChildPath(parent, 'alice.md'),
      );

      expect(readFileSync(join(outsideDir, 'alice.md'), 'utf-8')).toBe('OUTSIDE\n');
      expect(readFileSync(join(movedPeopleDir, 'alice.md'), 'utf-8')).toBe('PRIVATE\n');
    } finally {
      __testing.closeAnchoredParent(parent);
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('dirty guard ignores unrelated changes but blocks an exact target path', () => {
    execFileSync('git', ['init', '-q', brainDir]);
    writeFileSync(join(brainDir, 'unrelated.md'), 'unrelated\n');
    expect(__testing.areTargetPathsDirty(brainDir, ['people/alice'])).toBe(false);

    writeEntityPage('people/alice');
    expect(__testing.areTargetPathsDirty(brainDir, ['people/alice'])).toBe(true);
  });

  test('dirty guard treats glob-shaped destination names literally', () => {
    execFileSync('git', ['init', '-q', brainDir]);
    execFileSync('git', ['-C', brainDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', brainDir, 'config', 'user.name', 'test']);
    writeEntityPage('people/literal*');
    execFileSync('git', ['-C', brainDir, 'add', '.']);
    execFileSync('git', ['-C', brainDir, 'commit', '-qm', 'baseline']);

    writeEntityPage('people/literal-other');
    expect(__testing.areTargetPathsDirty(brainDir, ['people/literal*'])).toBe(false);

    writeFileSync(join(brainDir, 'people', 'literal*.md'), 'changed\n');
    expect(__testing.areTargetPathsDirty(brainDir, ['people/literal*'])).toBe(true);
  });

  test('dirty guard treats Git pathspec-magic-shaped destinations literally', () => {
    execFileSync('git', ['init', '-q', brainDir]);
    const slug = ':(exclude)people/alice';
    writeEntityPage(slug);
    expect(__testing.areTargetPathsDirty(brainDir, [slug])).toBe(true);
  });

  test('leaves a pre-existing legacy .md.tmp file untouched', async () => {
    writeEntityPage('people/alice');
    const legacyTmp = join(brainDir, 'people', 'alice.md.tmp');
    writeFileSync(legacyTmp, 'USER DATA\n');
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Fenced safely' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(readFileSync(legacyTmp, 'utf-8')).toBe('USER DATA\n');
  });
});

describe('phaseCVerify', () => {
  test('returns complete when fence + DB row counts match', async () => {
    writeEntityPage('people/alice');
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F1' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F2' });
    await __testing.phaseBFenceFacts(engine, OPTS);

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('pages_checked=1');
  });

  test('returns failed when fence row count drifts from DB', async () => {
    writeEntityPage('people/alice');
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F1' });
    await __testing.phaseBFenceFacts(engine, OPTS);

    // Corrupt the fence: append a row manually that's not in the DB.
    const path = join(brainDir, 'people/alice.md');
    const body = readFileSync(path, 'utf-8');
    const corrupted = body.replace(
      '<!--- gbrain:facts:end -->',
      '| 99 | extra row | fact | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n<!--- gbrain:facts:end -->',
    );
    writeFileSync(path, corrupted, 'utf-8');

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('drifted');
    expect(r.detail).toContain('people/alice');
  });

  test('returns failed when a same-count DB row has different fact identity', async () => {
    writeEntityPage('people/alice');
    const id = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Original' });
    await __testing.phaseBFenceFacts(engine, OPTS);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE facts SET visibility = 'world' WHERE id = $1`,
      [id],
    );

    const result = await __testing.phaseCVerify(engine, OPTS);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('identity drift at row=1');
  });
});

describe('orchestrator end-to-end', () => {
  test('clean run returns status:complete with 3 phases', async () => {
    writeEntityPage('people/alice');
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    const result = await v0_32_2.orchestrator(OPTS);
    expect(result.version).toBe('0.32.2');
    expect(result.status).toBe('complete');
    expect(result.phases.map(p => p.name)).toEqual(['schema', 'fence_facts', 'verify']);
    expect(result.phases.every(p => p.status === 'complete')).toBe(true);
  });

  test('dry-run returns 3 phases all skipped (no FS or DB changes)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Should not get fenced' });

    const result = await v0_32_2.orchestrator(DRY_OPTS);
    expect(result.status).toBe('complete');
    expect(result.phases.every(p => p.status === 'skipped')).toBe(true);
    expect(result.target_manifest).toMatchObject({
      version: '0.32.2',
      legacy_rows: 1,
      target_count: 1,
      quarantine_count: 1,
      targets: [{
        original_entity_slug: 'people/alice',
        disposition: 'quarantine',
        reason: 'missing_target',
      }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT row_num FROM facts');
    expect(rows.rows[0].row_num).toBeNull();
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false);
  });
});

afterAll(() => {
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});
