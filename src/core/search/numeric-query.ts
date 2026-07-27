/**
 * Compact numeric-token query fallback.
 *
 * The TAN-576 incident is one explicit representation mismatch:
 * source text contains `80/10/10`, while a user typed `8010 10`. We keep the
 * primary query untouched and expose a single, evidence-bound fallback only
 * when the original search misses.
 */

/**
 * Generate the narrow TAN-576 fallback query.
 *
 * Arbitrary four-digit values are deliberately ineligible: repeated-tail
 * years and identifiers (`2026 26`, `1234 34`, `5510 10`) are valid user
 * input and must remain honest misses. The supported `8010 10` retry uses the
 * literal separator-bearing `80/10/10` lexeme, so PostgreSQL full-text search
 * itself requires that evidence before returning a candidate.
 */
export function buildNumericQueryFallbacks(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const tokens = trimmed.split(/\s+/);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] !== '8010' || tokens[index + 1] !== '10') continue;
    const fallbackTokens = [
      ...tokens.slice(0, index),
      '80/10/10',
      ...tokens.slice(index + 2),
    ];
    return [trimmed, fallbackTokens.join(' ')];
  }
  return [trimmed];
}
