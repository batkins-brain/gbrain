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
 * We only emit the expanded variant when the query contains both a compact
 * 4-digit token and at least one ordinary 2-digit numeric token. That keeps
 * plain numeric lookups like years/IDs untouched while still recovering
 * compact 80/10-style inputs.
 */
export function buildNumericQueryFallbacks(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const tokens = splitQueryTokens(trimmed);
  if (tokens.length === 0) return [trimmed];

  const hasCompactFourDigitToken = tokens.some(token => /^\d{4}$/.test(token));
  const hasTwoDigitToken = tokens.some(token => /^\d{2}$/.test(token));
  if (!hasCompactFourDigitToken || !hasTwoDigitToken) return [trimmed];

  const expanded = trimmed.replace(/\b(\d{2})(\d{2})\b/g, '$1 $2');
  if (expanded === trimmed) return [trimmed];

  return [trimmed, expanded];
}
