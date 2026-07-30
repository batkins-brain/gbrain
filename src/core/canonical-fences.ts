import {
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
} from './facts-fence.ts';
import {
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
} from './takes-fence.ts';

interface FenceMarkers {
  begin: string;
  end: string;
  name: string;
}

const MANAGED_FENCES: FenceMarkers[] = [
  { begin: FACTS_FENCE_BEGIN, end: FACTS_FENCE_END, name: 'facts' },
  { begin: TAKES_FENCE_BEGIN, end: TAKES_FENCE_END, name: 'takes' },
];

function fenceRange(body: string, markers: FenceMarkers): [number, number] | null {
  const begin = body.indexOf(markers.begin);
  const end = body.indexOf(markers.end);
  if (begin === -1 && end === -1) return null;
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`canonical ${markers.name} fence is unbalanced`);
  }
  if (
    body.indexOf(markers.begin, begin + markers.begin.length) !== -1 ||
    body.indexOf(markers.end, end + markers.end.length) !== -1
  ) {
    throw new Error(`canonical ${markers.name} fence is duplicated`);
  }
  return [begin, end + markers.end.length];
}

/**
 * Markdown fences are canonical file-only state. A whole-page renderer may
 * refresh prose/frontmatter from the DB, but it must never delete or replace a
 * fence that was published while its earlier DB snapshot was waiting on the
 * page lock.
 */
export function preserveCanonicalFences(nextBody: string, currentBody: string): string {
  let merged = nextBody;
  for (const markers of MANAGED_FENCES) {
    const currentRange = fenceRange(currentBody, markers);
    if (!currentRange) continue;
    const canonicalFence = currentBody.slice(currentRange[0], currentRange[1]);
    const nextRange = fenceRange(merged, markers);
    if (nextRange) {
      merged = merged.slice(0, nextRange[0]) + canonicalFence + merged.slice(nextRange[1]);
    } else {
      merged = `${merged.trimEnd()}\n\n${canonicalFence}\n`;
    }
  }
  return merged;
}
