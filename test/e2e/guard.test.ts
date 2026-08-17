/**
 * Guards the guard: E2E setup must refuse any database that is not obviously a
 * test database.
 *
 * Regression cover for 2026-08-16, when an e2e run against the host's live
 * database truncated it to 0 pages / 0 chunks / 0 facts / 0 takes. The suite's
 * only protection at the time was `hasDatabase()`, which asserts DATABASE_URL is
 * *set* and never which database it addresses.
 *
 * Deliberately NOT gated on DATABASE_URL: this file must run in every
 * environment, including CI with no database, because it is the check that keeps
 * the destructive path honest.
 */
import { describe, test, expect } from 'bun:test';
import { assertTestDatabase, describeDbTarget } from './helpers.ts';

const PROD = 'postgresql://gbrain:hunter2@127.0.0.1:5433/gbrain';
const TEST = 'postgresql://postgres:postgres@localhost:5435/gbrain_test';

describe('assertTestDatabase', () => {
  test('refuses the production database that was actually truncated', () => {
    expect(() => assertTestDatabase(PROD)).toThrow(/Refusing to run E2E setup/);
  });

  test('allows a conventional test database', () => {
    expect(() => assertTestDatabase(TEST)).not.toThrow();
  });

  test.each([
    'postgresql://u:p@h:5432/test',
    'postgresql://u:p@h:5432/gbrain_test',
    'postgresql://u:p@h:5432/test_gbrain',
    'postgresql://u:p@h:5432/gbrain-test',
    'postgresql://u:p@h:5432/gbrain_test2',
  ])('accepts %s', (url) => {
    expect(() => assertTestDatabase(url)).not.toThrow();
  });

  test.each([
    'postgresql://u:p@h:5432/gbrain',
    'postgresql://u:p@h:5432/production',
    'postgresql://u:p@h:5432/gbrain_prod',
    // "latest" contains "test" as a substring but is not a test database --
    // the boundary anchors exist to reject exactly this.
    'postgresql://u:p@h:5432/latest',
    'postgresql://u:p@h:5432/greatest',
  ])('rejects %s', (url) => {
    expect(() => assertTestDatabase(url)).toThrow(/Refusing to run E2E setup/);
  });

  test('names the target so the failure is actionable', () => {
    expect(() => assertTestDatabase(PROD)).toThrow(/"gbrain" at 127\.0\.0\.1:5433/);
  });

  test('never leaks credentials into the error', () => {
    let message = '';
    try {
      assertTestDatabase(PROD);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('gbrain:hunter2');
  });

  test('an unparseable URL is refused rather than assumed safe', () => {
    expect(() => assertTestDatabase('not-a-url')).toThrow(/Refusing to run E2E setup/);
  });
});

describe('describeDbTarget', () => {
  test('extracts host, port and database without credentials', () => {
    expect(describeDbTarget(PROD)).toEqual({
      host: '127.0.0.1',
      port: '5433',
      database: 'gbrain',
    });
  });

  test('defaults the port when the URL omits it', () => {
    expect(describeDbTarget('postgresql://u:p@example/gbrain_test').port).toBe('5432');
  });
});
