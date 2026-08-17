/**
 * Case-preserving slug → path resolution (src/core/slug-path.ts).
 *
 * Regression coverage for the vault-shadowing bug: a lowercased slug
 * (`00_index/home`) must resolve onto the vault's real `00_INDEX/Home.md`
 * instead of creating a shadow tree beside it.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSlugPathOnDisk } from '../src/core/slug-path.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-slug-path-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(relPath: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '# x\n');
}

describe('resolveSlugPathOnDisk', () => {
  test('adopts existing uppercase directory AND file casing', () => {
    touch('00_INDEX/Home.md');
    expect(resolveSlugPathOnDisk(root, '00_index/home')).toBe(
      join(root, '00_INDEX', 'Home.md'),
    );
  });

  test('resolves each segment independently (mixed casing per level)', () => {
    // Mirrors the real vault: uppercase, TitleCase, UPPER, and a genuinely
    // lowercase segment all in one path.
    touch('20_WORKING/Historical_Ingestion/REALQ094/quarantined_sources/TF_CONTEXT.md');
    expect(
      resolveSlugPathOnDisk(
        root,
        '20_working/historical_ingestion/realq094/quarantined_sources/tf_context',
      ),
    ).toBe(
      join(root, '20_WORKING', 'Historical_Ingestion', 'REALQ094', 'quarantined_sources', 'TF_CONTEXT.md'),
    );
  });

  test('keeps the literal slug when nothing exists yet (new page)', () => {
    expect(resolveSlugPathOnDisk(root, 'people/alice-example')).toBe(
      join(root, 'people', 'alice-example.md'),
    );
  });

  test('adopts an existing directory but keeps a literal new filename', () => {
    mkdirSync(join(root, '03_SYSTEMS'), { recursive: true });
    expect(resolveSlugPathOnDisk(root, '03_systems/brand-new')).toBe(
      join(root, '03_SYSTEMS', 'brand-new.md'),
    );
  });

  test('exact match wins over a case-variant sibling', () => {
    touch('notes/home.md');
    touch('notes/Home.md');
    expect(resolveSlugPathOnDisk(root, 'notes/home')).toBe(
      join(root, 'notes', 'home.md'),
    );
  });

  test('ambiguous case-variants with no exact match stay literal', () => {
    touch('notes/Home.md');
    touch('notes/HOME.md');
    // Two candidates, neither exact — refuse to guess, keep prior behavior.
    expect(resolveSlugPathOnDisk(root, 'notes/home')).toBe(
      join(root, 'notes', 'home.md'),
    );
  });

  test('single-segment slug resolves against the root', () => {
    touch('README.md');
    expect(resolveSlugPathOnDisk(root, 'readme')).toBe(join(root, 'README.md'));
  });

  test('unreadable/missing intermediate directory falls back to literal', () => {
    expect(resolveSlugPathOnDisk(root, 'a/b/c/d')).toBe(
      join(root, 'a', 'b', 'c', 'd.md'),
    );
  });

  test('does not rewrite a vault that is already all-lowercase', () => {
    touch('topics/systems.md');
    expect(resolveSlugPathOnDisk(root, 'topics/systems')).toBe(
      join(root, 'topics', 'systems.md'),
    );
  });

  test('stays within root — no traversal introduced by resolution', () => {
    touch('00_INDEX/Home.md');
    const resolved = resolveSlugPathOnDisk(root, '00_index/home');
    expect(resolved.startsWith(root)).toBe(true);
  });
});
