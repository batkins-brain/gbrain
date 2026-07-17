/**
 * Regression tests for issue #1 (F14b): multi-query expansion / semantic
 * cache path bypassing GBRAIN_SEARCH_EXCLUDE hard-excludes and
 * GBRAIN_SOURCE_BOOST demotions.
 *
 * Observed field failure (v0.42.56.0, postgres engine, TF Brain estate
 * remediation): with GBRAIN_SEARCH_EXCLUDE=20_working/,30_generated/ set,
 * `gbrain search` and `gbrain query --no-expand` filtered correctly, but
 * default `gbrain query` (expansion ON) returned 20_working/… quarantined
 * slugs as top-3. Root cause: expansion=0 and expansion=1 are DIFFERENT
 * cache rows (knobs hash), and the retrieval policy was not part of the
 * hash — so the expansion-ON row, written before the exclude was
 * configured, kept serving quarantined content until TTL while the
 * expansion-OFF row was freshly written post-policy and looked correct.
 *
 * Fix under test:
 *   1. knobsHash v=12 folds hardExcludes + sourceBoosts (KnobsHashContext)
 *      → policy changes structurally invalidate prior cache rows.
 *   2. filterHardExcluded() — single post-pipeline enforcement point used
 *      by every hybridSearch return path AND the cache-hit path, covering
 *      side channels that bypass the SQL clause (alias-hop injection,
 *      two-pass hydration, relational arm, stale cache rows).
 *   3. hybridSearch's explicit searchOpts rebuild threads per-call
 *      exclude_slug_prefixes / include_slug_prefixes (same drop class as
 *      the #861 source-scope leak).
 */
import { describe, expect, test } from 'bun:test';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';
import { filterHardExcluded } from '../src/core/search/hybrid.ts';
import { resolveHardExcludes } from '../src/core/search/source-boost.ts';
import type { SearchResult } from '../src/core/types.ts';

const knobs = resolveSearchMode({ mode: 'balanced' });

function makeResult(slug: string): SearchResult {
  return {
    slug,
    page_id: 1,
    title: slug,
    type: 'note',
    chunk_text: 'body',
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 0.5,
    stale: false,
  } as SearchResult;
}

describe('knobsHash v=12 retrieval-policy isolation (issue #1)', () => {
  test('different hard-exclude sets produce different cache keys', () => {
    const before = knobsHash(knobs, { hardExcludes: ['test/'] });
    const after = knobsHash(knobs, {
      hardExcludes: ['test/', '20_working/', '30_generated/'],
    });
    expect(before).not.toBe(after);
  });

  test('different boost maps produce different cache keys', () => {
    const neutral = knobsHash(knobs, { hardExcludes: ['test/'] });
    const demoted = knobsHash(knobs, {
      hardExcludes: ['test/'],
      sourceBoosts: { '20_working/': 0.05 },
    });
    expect(neutral).not.toBe(demoted);
  });

  test('exclude-list ORDER does not split the key (canonicalized)', () => {
    const a = knobsHash(knobs, { hardExcludes: ['a/', 'b/'] });
    const b = knobsHash(knobs, { hardExcludes: ['b/', 'a/'] });
    expect(a).toBe(b);
  });

  test('boost-map insertion order does not split the key (canonicalized)', () => {
    const a = knobsHash(knobs, { sourceBoosts: { 'x/': 1.5, 'y/': 0.5 } });
    const b = knobsHash(knobs, { sourceBoosts: { 'y/': 0.5, 'x/': 1.5 } });
    expect(a).toBe(b);
  });

  test('policy-less callers still hash stably (fallback literals)', () => {
    expect(knobsHash(knobs)).toBe(knobsHash(knobs, {}));
  });
});

describe('filterHardExcluded final enforcement (issue #1)', () => {
  const results = [
    makeResult('10_CANONICAL/context-bridge'),
    makeResult('20_working/quarantined_sources/dump-1'),
    makeResult('30_generated/derived/x'),
    makeResult('agent-alignment/codex-wsl'),
  ];

  test('drops excluded prefixes, keeps everything else, preserves order', () => {
    const kept = filterHardExcluded(results, ['20_working/', '30_generated/']);
    expect(kept.map(r => r.slug)).toEqual([
      '10_CANONICAL/context-bridge',
      'agent-alignment/codex-wsl',
    ]);
  });

  test('startsWith semantics — matches slug LIKE prefix%, not substring', () => {
    const r = [makeResult('notes/20_working-summary')];
    expect(filterHardExcluded(r, ['20_working/'])).toHaveLength(1);
  });

  test('empty prefix list is a passthrough (same reference, zero cost)', () => {
    expect(filterHardExcluded(results, [])).toBe(results);
  });

  test('composes with resolveHardExcludes env+per-call semantics', () => {
    const prefixes = resolveHardExcludes(
      ['20_working/'],
      // opt-back-in removes a DEFAULT exclude; 20_working/ must survive
      ['test/'],
      '30_generated/',
    );
    const kept = filterHardExcluded(results, prefixes);
    expect(kept.map(r => r.slug)).toEqual([
      '10_CANONICAL/context-bridge',
      'agent-alignment/codex-wsl',
    ]);
    // test/ was opted back in → a test/ slug would be kept
    expect(filterHardExcluded([makeResult('test/fixture')], prefixes)).toHaveLength(1);
  });
});
