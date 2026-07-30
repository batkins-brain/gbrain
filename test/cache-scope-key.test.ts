/**
 * Query-cache scope key (federation hardening) + cache-hit source filter.
 */

import { describe, test, expect } from 'bun:test';
import { cacheScopeKey, filterResultsBySourceScope } from '../src/core/search/hybrid.ts';

describe('cacheScopeKey', () => {
  test('unscoped → default (single-source unchanged)', () => {
    expect(cacheScopeKey(undefined)).toBe('default');
    expect(cacheScopeKey({})).toBe('default');
  });

  test('scalar sourceId → itself (single-source unchanged)', () => {
    expect(cacheScopeKey({ sourceId: 'host' })).toBe('host');
  });

  test('federated sourceIds → order-independent set key', () => {
    const k1 = cacheScopeKey({ sourceIds: ['team-b', 'team-a', 'host'] });
    const k2 = cacheScopeKey({ sourceIds: ['host', 'team-a', 'team-b'] });
    expect(k1).toBe(k2);
    expect(k1).toBe('__set__:host,team-a,team-b');
  });

  test('different source-sets do NOT share a key', () => {
    const a = cacheScopeKey({ sourceIds: ['host', 'team-a'] });
    const b = cacheScopeKey({ sourceIds: ['host', 'team-b'] });
    expect(a).not.toBe(b);
  });

  test('federated set key is distinct from any single scalar key', () => {
    const set = cacheScopeKey({ sourceIds: ['host'] });
    const scalar = cacheScopeKey({ sourceId: 'host' });
    expect(set).not.toBe(scalar);
  });

  test('empty sourceIds does not collapse to default', () => {
    expect(cacheScopeKey({ sourceIds: [] })).toBe('__set__:');
    expect(cacheScopeKey({ sourceIds: [] })).not.toBe('default');
  });
});

function hit(source_id: string, slug: string) {
  return {
    slug,
    source_id,
    score: 1,
    chunk_text: 'x',
  } as any;
}

describe('filterResultsBySourceScope — TAN-576 cache-hit boundary', () => {
  const rows = [
    hit('default', 'inbox/a'),
    hit('24-105', '24-105/rulings/layback-8010-10-allocated'),
    hit('default', '24-105/findings/local-copy'),
  ];

  test('scalar sourceId drops out-of-scope rows', () => {
    const filtered = filterResultsBySourceScope(rows, { sourceId: 'default' });
    expect(filtered.map(r => `${r.source_id}:${r.slug}`)).toEqual([
      'default:inbox/a',
      'default:24-105/findings/local-copy',
    ]);
  });

  test('federated sourceIds keep only members', () => {
    const filtered = filterResultsBySourceScope(rows, { sourceIds: ['24-105', 'default'] });
    expect(filtered).toHaveLength(3);
    const only105 = filterResultsBySourceScope(rows, { sourceIds: ['24-105'] });
    expect(only105.map(r => r.source_id)).toEqual(['24-105']);
  });

  test('unscoped leaves rows unchanged', () => {
    expect(filterResultsBySourceScope(rows, {})).toHaveLength(3);
    expect(filterResultsBySourceScope(rows, undefined)).toHaveLength(3);
  });

  test('empty federated sourceIds fails closed (no rows)', () => {
    const filtered = filterResultsBySourceScope(rows, { sourceIds: [] });
    expect(filtered).toEqual([]);
  });
});
