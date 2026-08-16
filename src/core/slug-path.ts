/**
 * Case-preserving slug → on-disk path resolution.
 *
 * Slugs are a NORMALIZED identifier: `validateSlug` (src/core/utils.ts) and
 * `pathToSlug` (src/core/sync.ts) both lowercase, so every row in `pages`
 * carries a lowercased slug by construction. That is correct for identity —
 * but a filesystem path is NOT an identity, and deriving one by
 * `join(root, slug + '.md')` silently invents a lowercased path.
 *
 * On a case-SENSITIVE filesystem (Linux) that creates a *shadow* tree
 * alongside the real one: a vault holding `00_INDEX/Home.md` grows an
 * untracked `00_index/home.md`, and every fact written there is invisible to
 * the note it was meant for. On a case-INSENSITIVE filesystem (macOS,
 * Windows) the two collide instead, which is how the same bug surfaces as an
 * Obsidian/iCloud sync conflict.
 *
 * `resolveSlugPathOnDisk` walks the slug segment by segment and, at each
 * level, prefers the name that ALREADY EXISTS on disk over the literal
 * lowercased segment. Only genuinely new segments are created with the
 * literal spelling, so this never renames or re-cases anything that exists.
 *
 * Deliberately best-effort and non-throwing: path resolution must never be
 * the reason a fact write fails. Any unreadable directory falls back to the
 * literal segment, which is exactly today's behavior.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Find the real on-disk spelling of `name` inside `dir`.
 *
 * Returns `name` unchanged when the directory can't be read, when nothing
 * matches, or when the match is ambiguous — the caller then creates the
 * literal spelling, which is the pre-fix behavior.
 *
 * We ALWAYS read the directory rather than probing with `existsSync`,
 * because on a case-insensitive filesystem `existsSync('00_index')` is true
 * when only `00_INDEX` exists — the probe would report success and hand back
 * the wrong spelling. `readdirSync` returns the true entry name on every
 * platform.
 */
function realNameIn(dir: string, name: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Missing / unreadable parent: nothing to reconcile against.
    return name;
  }

  // Exact match wins outright — no scan needed, and it keeps behavior
  // identical for the overwhelmingly common all-lowercase vault.
  if (entries.includes(name)) return name;

  const lowered = name.toLowerCase();
  const matches = entries.filter(e => e.toLowerCase() === lowered);

  // Exactly one case-variant → adopt its real spelling. Zero matches → new
  // entry, use the literal. Two or more (only reachable on a case-sensitive
  // FS that already holds e.g. both `Home.md` and `home.md`) → ambiguous, so
  // stay literal rather than guessing which note the caller meant.
  return matches.length === 1 ? matches[0]! : name;
}

/**
 * Resolve `<root>/<slug>.md`, preserving the case of directories and of the
 * file itself wherever they already exist under `root`.
 *
 * `slug` is expected to be a validated, `/`-separated slug (no `..`, no
 * backslashes) — callers already enforce that via `validateSlug` /
 * `validateSourceId`, and this helper deliberately does not re-validate or
 * re-confine. Containment stays the caller's job (`isWriteTargetContained`).
 *
 * Example, against a vault holding `00_INDEX/Home.md`:
 *   resolveSlugPathOnDisk('/vault', '00_index/home')
 *     → '/vault/00_INDEX/Home.md'      (not '/vault/00_index/home.md')
 */
export function resolveSlugPathOnDisk(root: string, slug: string): string {
  const segments = slug.split('/');
  const fileName = `${segments.pop()!}.md`;

  let current = root;
  for (const segment of segments) {
    current = join(current, realNameIn(current, segment));
  }
  return join(current, realNameIn(current, fileName));
}
