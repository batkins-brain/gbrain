import {
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
} from './facts-fence.ts';
import {
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
} from './takes-fence.ts';
import { insertSectionBeforeTimeline } from './markdown-sections.ts';

interface FenceMarkers {
  begin: string;
  end: string;
  name: string;
  heading: string;
}

const MANAGED_FENCES: FenceMarkers[] = [
  { begin: FACTS_FENCE_BEGIN, end: FACTS_FENCE_END, name: 'facts', heading: '## Facts' },
  { begin: TAKES_FENCE_BEGIN, end: TAKES_FENCE_END, name: 'takes', heading: '## Takes' },
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

function managedSectionRange(body: string, markers: FenceMarkers): [number, number] | null {
  const range = fenceRange(body, markers);
  if (!range) return null;

  const prefix = body.slice(0, range[0]);
  const escapedHeading = markers.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingMatch = prefix.match(
    new RegExp(`(?:^|\\n)${escapedHeading}[ \\t]*\\n(?:[ \\t]*\\n)*$`),
  );
  if (!headingMatch) return range;

  const leadingNewline = headingMatch[0].startsWith('\n') ? 1 : 0;
  return [prefix.length - headingMatch[0].length + leadingNewline, range[1]];
}

/**
 * Markdown fences are canonical file-only state. A whole-page renderer may
 * refresh prose/frontmatter from the DB, but the current file's fence state —
 * including canonical absence — always wins over an earlier DB snapshot.
 */
export function preserveCanonicalFences(nextBody: string, currentBody: string): string {
  let merged = nextBody;
  for (const markers of MANAGED_FENCES) {
    const currentRange = fenceRange(currentBody, markers);
    const nextRange = managedSectionRange(merged, markers);
    if (!currentRange) {
      if (nextRange) {
        merged = merged.slice(0, nextRange[0]) + merged.slice(nextRange[1]);
      }
      continue;
    }

    const canonicalFence = currentBody.slice(currentRange[0], currentRange[1]);
    const canonicalSection = `${markers.heading}\n\n${canonicalFence}`;
    if (nextRange) {
      merged = merged.slice(0, nextRange[0]) + merged.slice(nextRange[1]);
    }
    merged = insertSectionBeforeTimeline(merged, canonicalSection);
  }
  return merged;
}
