import { describe, expect, test } from 'bun:test';
import { buildNumericQueryFallbacks } from '../../src/core/search/numeric-query.ts';

describe('buildNumericQueryFallbacks', () => {
  test('expands compact numeric separators for mixed queries', () => {
    expect(buildNumericQueryFallbacks('layback 8010 10 allocated')).toEqual([
      'layback 8010 10 allocated',
      'layback 80/10/10 allocated',
    ]);
  });

  test('leaves years, identifiers, ordinary numerics, and non-repeated queries unchanged', () => {
    expect(buildNumericQueryFallbacks('2026')).toEqual(['2026']);
    expect(buildNumericQueryFallbacks('project 2026')).toEqual(['project 2026']);
    expect(buildNumericQueryFallbacks('2026 10')).toEqual(['2026 10']);
    expect(buildNumericQueryFallbacks('report 2026 26')).toEqual(['report 2026 26']);
    expect(buildNumericQueryFallbacks('case 1234 34')).toEqual(['case 1234 34']);
    expect(buildNumericQueryFallbacks('invoice 5510 10')).toEqual(['invoice 5510 10']);
    expect(buildNumericQueryFallbacks('layback 2026 10 allocated')).toEqual(['layback 2026 10 allocated']);
    expect(buildNumericQueryFallbacks('layback 8010 12 allocated')).toEqual(['layback 8010 12 allocated']);
  });
});
