/**
 * Write-target authorization tests (src/core/write-policy.ts + its wiring into
 * write-through). #28.
 *
 * The defect these pin: write-through proved only CONTAINMENT (is the path
 * inside the source tree?) and treated that as AUTHORIZATION. A downstream
 * vault's human-governed canonical folder is inside the source tree, so a
 * facts write-back landed there — in a note whose own frontmatter said
 * `agent_editable: false`, in a repo whose policy file says agents write to one
 * inbox directory only.
 *
 * The vault layout used in the fixtures mirrors that real one: `99_INBOX` is
 * the authorized review tier; `03_SYSTEMS` is canonical; `20_WORKING` is a
 * working tier that is NOT authorized unless separately configured; `00_Inbox`
 * is an undefined historical path that must never be authorized implicitly by
 * looking inbox-shaped.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { writePageThrough } from '../src/core/write-through.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { authorizeWriteTarget, readWriteRoots } from '../src/core/write-policy.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let vaultDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-write-policy-'));
  vaultDir = path.join(tmpRoot, 'vault');
  for (const dir of ['99_INBOX', '03_SYSTEMS', '20_WORKING', '00_Inbox']) {
    fs.mkdirSync(path.join(vaultDir, dir), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── unit: the policy function itself ───────────────────────────────────────

describe('readWriteRoots', () => {
  test('absent key → null (no policy configured)', () => {
    expect(readWriteRoots({})).toBeNull();
    expect(readWriteRoots(null)).toBeNull();
    expect(readWriteRoots('not json')).toBeNull();
  });

  test('non-array value → null, not a lenient coercion', () => {
    expect(readWriteRoots({ write_roots: '99_INBOX' })).toBeNull();
  });

  test('explicit empty array is preserved and is distinct from unset', () => {
    expect(readWriteRoots({ write_roots: [] })).toEqual([]);
  });

  test('parses from a JSON string config (driver shape variance)', () => {
    expect(readWriteRoots(JSON.stringify({ write_roots: ['99_INBOX'] }))).toEqual(['99_INBOX']);
  });
});

describe('authorizeWriteTarget', () => {
  const target = (rel: string) => path.join('/vault', rel);

  test('unset policy fails closed', () => {
    const d = authorizeWriteTarget('/vault', target('99_INBOX/a.md'), null);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('write_policy_unset');
  });

  test('empty policy denies, with its own distinct reason', () => {
    const d = authorizeWriteTarget('/vault', target('99_INBOX/a.md'), []);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('write_policy_empty');
  });

  test('absolute or dot-segment roots are refused rather than resolved', () => {
    for (const bad of [['/etc'], ['../..'], ['./99_INBOX'], ['99_INBOX/../03_SYSTEMS']]) {
      const d = authorizeWriteTarget('/vault', target('99_INBOX/a.md'), bad);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('write_root_malformed');
    }
  });

  test('backslash root is refused (alternate separator)', () => {
    const d = authorizeWriteTarget('/vault', target('99_INBOX/a.md'), ['99_INBOX\\nested']);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('write_root_malformed');
  });
});

// ─── integration: through writePageThrough, against a real tree ─────────────

async function seed(slug: string): Promise<void> {
  await importFromContent(engine, slug, `---\ntitle: T\ntype: note\n---\n\n# Body\n`, {
    noEmbed: true,
    sourceId: 'vault',
    sourcePath: `${slug}.md`,
  });
}

async function addSource(writeRoots: string[] | null): Promise<void> {
  const config = writeRoots === null ? {} : { write_roots: writeRoots };
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
    ['vault', 'vault', vaultDir, JSON.stringify(config)],
  );
}

describe('writePageThrough write-root enforcement', () => {
  test('authorized root: a 99_INBOX write succeeds', async () => {
    await addSource(['99_INBOX']);
    await seed('99_inbox/note');
    const res = await writePageThrough(engine, '99_inbox/note', { sourceId: 'vault' });
    expect(res.written).toBe(true);
    expect(res.path!.startsWith(path.join(vaultDir, '99_INBOX'))).toBe(true);
  });

  test('canonical folder is denied even though it exists inside the source', async () => {
    await addSource(['99_INBOX']);
    await seed('03_systems/paperclip');
    const res = await writePageThrough(engine, '03_systems/paperclip', { sourceId: 'vault' });
    expect(res.written).toBe(false);
    expect(res.skipped).toBe('target_outside_write_roots');
  });

  test('20_WORKING is denied unless separately configured, and allowed when it is', async () => {
    await addSource(['99_INBOX']);
    await seed('20_working/scratch');
    expect((await writePageThrough(engine, '20_working/scratch', { sourceId: 'vault' })).skipped)
      .toBe('target_outside_write_roots');

    await engine.executeRaw(
      `UPDATE sources SET config = $1::text::jsonb WHERE id = 'vault'`,
      [JSON.stringify({ write_roots: ['99_INBOX', '20_WORKING'] })],
    );
    expect((await writePageThrough(engine, '20_working/scratch', { sourceId: 'vault' })).written)
      .toBe(true);
  });

  test('00_Inbox is denied — inbox-shaped is not authorization', async () => {
    await addSource(['99_INBOX']);
    await seed('00_inbox/pathforge/note');
    const res = await writePageThrough(engine, '00_inbox/pathforge/note', { sourceId: 'vault' });
    expect(res.written).toBe(false);
    expect(res.skipped).toBe('target_outside_write_roots');
  });

  test('no write_roots configured fails closed — inside the repo is not enough', async () => {
    await addSource(null);
    await seed('99_inbox/note');
    const res = await writePageThrough(engine, '99_inbox/note', { sourceId: 'vault' });
    expect(res.written).toBe(false);
    expect(res.skipped).toBe('write_policy_unset');
  });

  test('a denied write leaves an existing target byte-identical', async () => {
    await addSource(['99_INBOX']);
    const canonical = path.join(vaultDir, '03_SYSTEMS', 'paperclip.md');
    const original = '---\ntitle: Human\nagent_editable: false\n---\n\nHuman-authored body.\n';
    fs.writeFileSync(canonical, original, 'utf8');
    const before = fs.statSync(canonical).mtimeMs;

    await seed('03_systems/paperclip');
    const res = await writePageThrough(engine, '03_systems/paperclip', { sourceId: 'vault' });

    expect(res.written).toBe(false);
    expect(fs.readFileSync(canonical, 'utf8')).toBe(original);
    expect(fs.statSync(canonical).mtimeMs).toBe(before);
  });

  test('a denied write creates no directories and no .tmp siblings', async () => {
    await addSource(['99_INBOX']);
    await seed('06_decisions/nested/deep/note');
    const res = await writePageThrough(engine, '06_decisions/nested/deep/note', { sourceId: 'vault' });
    expect(res.written).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, '06_DECISIONS'))).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, '06_decisions'))).toBe(false);
  });

  test('symlinked directory inside an authorized root cannot escape it', async () => {
    await addSource(['99_INBOX']);
    // 99_INBOX/escape -> 03_SYSTEMS. A path-string prefix check would accept
    // 99_INBOX/escape/x.md; realpath resolution must not.
    fs.symlinkSync(path.join(vaultDir, '03_SYSTEMS'), path.join(vaultDir, '99_INBOX', 'escape'));
    const decision = authorizeWriteTarget(
      vaultDir,
      path.join(vaultDir, '99_INBOX', 'escape', 'x.md'),
      ['99_INBOX'],
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('target_outside_write_roots');
  });

  test('a symlinked write ROOT that points outside the source is refused', async () => {
    const outside = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(vaultDir, 'linked_root'));
    const decision = authorizeWriteTarget(
      vaultDir,
      path.join(vaultDir, 'linked_root', 'x.md'),
      ['linked_root'],
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('write_root_escapes_source');
  });

  test('authorization is evaluated before mutation, so dryRun stays non-mutating', async () => {
    // The caller owns dryRun (operations.ts) and never reaches this helper, so
    // the guarantee to pin here is the helper's own: a refusal writes nothing.
    await addSource([]);
    await seed('99_inbox/note');
    const res = await writePageThrough(engine, '99_inbox/note', { sourceId: 'vault' });
    expect(res.written).toBe(false);
    expect(res.skipped).toBe('write_policy_empty');
    expect(fs.readdirSync(path.join(vaultDir, '99_INBOX'))).toEqual([]);
  });
});
