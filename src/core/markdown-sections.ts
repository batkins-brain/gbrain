/**
 * Pure markdown section-placement helpers.
 *
 * This module intentionally has no imports so fence parsers and fuzz targets
 * can use it without pulling filesystem or database dependencies into their
 * validation bundles.
 */

function findTimelineSplitIndex(lines: string[], startIndex = 0): number {
  for (let i = startIndex; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed === '<!-- timeline -->' || trimmed === '<!--timeline-->') {
      return i;
    }
    if (/^-{3,}\s+timeline\s+-{3,}$/i.test(trimmed)) {
      return i;
    }
    if (trimmed === '---') {
      const beforeContent = lines.slice(startIndex, i).join('\n').trim();
      if (beforeContent.length === 0) continue;

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next.length === 0) continue;
        if (/^##\s+(Timeline|History)\b/i.test(next)) return i;
        break;
      }
    }
  }
  return -1;
}

/**
 * Append a managed compiled-truth section without ever placing it in the
 * timeline channel. The input may be a complete markdown file or a body.
 */
export function insertSectionBeforeTimeline(body: string, section: string): string {
  const lines = body.split('\n');
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    const frontmatterEnd = lines.findIndex((line, index) =>
      index > 0 && line.trim() === '---');
    if (frontmatterEnd !== -1) bodyStart = frontmatterEnd + 1;
  }
  const splitIndex = findTimelineSplitIndex(lines, bodyStart);
  const managed = section.trimEnd();
  if (splitIndex === -1) {
    const sep = body.endsWith('\n') ? '\n' : '\n\n';
    return `${body}${sep}${managed}\n`;
  }

  const before = lines.slice(0, splitIndex).join('\n');
  const after = lines.slice(splitIndex).join('\n');
  const sep = before.endsWith('\n') ? '\n' : '\n\n';
  return `${before}${sep}${managed}\n\n${after}`;
}
