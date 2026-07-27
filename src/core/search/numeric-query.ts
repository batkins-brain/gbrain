/**
 * Compact numeric-token query fallback.
 *
 * Some source text uses separator-heavy numeric forms like `80/10/10`, while
 * users sometimes type compact variants such as `8010 10`. We keep the primary
 * query untouched and only generate a tiny fallback set when the original search
 * misses, so source isolation and ordinary numeric queries remain unchanged on
 * the fast path.
 */

function isNumericToken(token: string): boolean {
  return /^\d+$/.test(token);
}

function splitQueryTokens(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean);
}

/**
 * Generate a very small fallback set for compact numeric separators.
 *
 * A compact token is eligible only when the immediately following two-digit
 * token repeats its trailing pair: `8010 10` means `80/10/10`. That repeated
 * tail is the disambiguator which keeps ordinary year/ID phrases unchanged.
 */
export function buildNumericQueryFallbacks(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const tokens = splitQueryTokens(trimmed);
  if (tokens.length === 0) return [trimmed];

  const expandedTokens = [...tokens];
  let expandedAny = false;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const compact = tokens[index];
    const repeatedTail = tokens[index + 1];
    const match = /^(\d{2})(\d{2})$/.exec(compact);
    if (!match || !isNumericToken(repeatedTail) || repeatedTail.length !== 2 || match[2] !== repeatedTail) continue;
    expandedTokens[index] = `${match[1]} ${match[2]}`;
    expandedAny = true;
  }
  if (!expandedAny) return [trimmed];

  return [trimmed, expandedTokens.join(' ')];
}
