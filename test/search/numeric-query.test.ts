import { describe, expect, test } from 'bun:test';
import { buildNumericQueryFallbacks } from '../../src/core/search/numeric-query.ts';

describe('buildNumericQueryFallbacks', () => {
  test('expands compact numeric separators for mixed queries', () => {
    expect(buildNumericQueryFallbacks('layback 8010 10 allocated')).toEqual([
      'layback 8010 10 allocated',
      'layback 80 10 10 allocated',
    ]);
  });

  test('leaves ordinary numeric queries unchanged', () => {
    expect(buildNumericQueryFallbacks('2026')).toEqual(['2026']);
    expect(buildNumericQueryFallbacks('project 2026')).toEqual(['project 2026']);
  });
});
