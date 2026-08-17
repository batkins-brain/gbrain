/**
 * Write-target authorization for write-through (#28).
 *
 * THE DISTINCTION THIS MODULE EXISTS TO ENFORCE:
 *
 *   source `local_path`  — where GBrain may READ and sync FROM. Broad.
 *   `config.write_roots` — the much smaller subset it may WRITE INTO. Narrow.
 *
 * Before this, those were the same thing: `writePageThrough` proved only that
 * the computed path stayed under the source root (`isWriteTargetContained`)
 * and then wrote. "Inside the repo" was treated as sufficient authorization,
 * so a facts write-back landed in a downstream vault's human-governed
 * canonical folder — a folder whose own policy file says agents write only to
 * one inbox directory, into a note marked `agent_editable: false`.
 * Containment is not authorization.
 *
 * FAIL-CLOSED BY CONSTRUCTION. A source with no `write_roots` configured is
 * denied, not allowed. That is deliberately the opposite of the usual
 * "unset means no restriction" default: an unconfigured source is one nobody
 * has decided about yet, and the failure mode of guessing wrong is writing
 * into someone's reviewed knowledge base. Existing sources therefore stop
 * writing through until an operator names their roots — a visible,
 * reversible, one-config-key change, versus a silent corruption that is only
 * found by reading a diff.
 *
 * WHAT THIS IS NOT: a sync/read change. Nothing here affects search,
 * retrieval, ingestion, or what `gbrain sync` reads. It gates file mutation
 * only.
 */

import { resolve as resolvePath, join, isAbsolute } from 'path';

import { isWriteTargetContained } from './path-confine.ts';
import { parseSourceConfig } from './sources-load.ts';

/** Machine-stable denial codes; surfaced as write-through `skipped` values. */
export type WriteDenyReason =
  | 'write_policy_unset'
  | 'write_policy_empty'
  | 'write_root_malformed'
  | 'write_root_escapes_source'
  | 'target_outside_write_roots';

export interface WriteAuthorization {
  allowed: boolean;
  /** Set when denied. */
  reason?: WriteDenyReason;
  /** Set when allowed: the configured root (repo-relative) that authorized it. */
  root?: string;
  /** Human-readable, safe to log. */
  detail?: string;
}

/**
 * Read `config.write_roots` off a source row's JSONB config.
 *
 * Returns null when the key is absent or not an array — both mean "no policy
 * configured", which the caller must treat as deny. An explicitly empty array
 * is returned as `[]` and is also a deny, but a DIFFERENT one: it records that
 * someone deliberately authorized nothing, which is a legitimate way to pin a
 * source read-only.
 */
export function readWriteRoots(config: unknown): string[] | null {
  const parsed = parseSourceConfig(config);
  const raw = parsed.write_roots;
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Reject a configured root that cannot safely denote a subtree of the source.
 *
 * Absolute paths and `..` segments are refused outright rather than resolved:
 * a write root is a repo-relative subtree by definition, so anything else is a
 * misconfiguration, and silently resolving it is how `write_roots: ["../.."]`
 * would become "the whole filesystem".
 */
function rootIsWellFormed(root: string): boolean {
  if (!root || root.trim() !== root) return false;
  if (isAbsolute(root)) return false;
  if (root.includes('\\')) return false; // alternate separator
  if (root.split('/').some(seg => seg === '..' || seg === '.')) return false;
  return true;
}

/**
 * Decide whether `targetPath` may be written, given the source's repo root and
 * its configured write roots.
 *
 * Evaluated BEFORE any mkdir/write. Every failure path returns allowed:false —
 * there is no branch that falls through to permit.
 *
 * Symlink and traversal safety is delegated to `isWriteTargetContained`, which
 * realpaths the longest EXISTING prefix of the target before comparing. That
 * matters here because the target usually does not exist yet (it is the file
 * about to be created), and because a symlinked intermediate directory is
 * exactly how an allowed root gets escaped.
 */
export function authorizeWriteTarget(
  repoRoot: string,
  targetPath: string,
  writeRoots: string[] | null,
): WriteAuthorization {
  if (writeRoots == null) {
    return {
      allowed: false,
      reason: 'write_policy_unset',
      detail: 'source has no config.write_roots; write-through is denied until one is configured',
    };
  }
  if (writeRoots.length === 0) {
    return {
      allowed: false,
      reason: 'write_policy_empty',
      detail: 'source config.write_roots is empty; the source is pinned read-only',
    };
  }

  const malformed = writeRoots.filter(root => !rootIsWellFormed(root));
  if (malformed.length > 0) {
    return {
      allowed: false,
      reason: 'write_root_malformed',
      detail: `write_roots contains entries that are not repo-relative subtrees: ${malformed.join(', ')}`,
    };
  }

  const resolvedRepo = resolvePath(repoRoot);
  for (const root of writeRoots) {
    const absoluteRoot = join(resolvedRepo, root);
    // A root must itself sit inside the source. Belt-and-braces given
    // rootIsWellFormed already refused `..`/absolute — this also catches a
    // root that is a symlink pointing out of the tree.
    if (!isWriteTargetContained(absoluteRoot, resolvedRepo)) {
      return {
        allowed: false,
        reason: 'write_root_escapes_source',
        detail: `configured write root ${root} does not resolve inside the source tree`,
      };
    }
    if (isWriteTargetContained(targetPath, absoluteRoot)) {
      return { allowed: true, root };
    }
  }

  return {
    allowed: false,
    reason: 'target_outside_write_roots',
    detail: `target is not beneath any configured write root (${writeRoots.join(', ')})`,
  };
}
