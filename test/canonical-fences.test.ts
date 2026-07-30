import { describe, expect, test } from 'bun:test';
import { preserveCanonicalFences } from '../src/core/canonical-fences.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

const factsFence = `${FACTS_FENCE_BEGIN}
| row_num | claim |
|---:|---|
| 1 | Current fact |
${FACTS_FENCE_END}`;

const takesFence = `${TAKES_FENCE_BEGIN}
| # | claim |
|---:|---|
| 1 | Current take |
${TAKES_FENCE_END}`;

describe('preserveCanonicalFences', () => {
  test('current facts fence and heading win and remain before the timeline', () => {
    const current = `# Page

## Facts

${factsFence}

<!-- timeline -->
## Timeline
`;
    const staleRender = `# Page

Stale DB prose.

<!-- timeline -->
## Timeline
`;
    const merged = preserveCanonicalFences(staleRender, current);

    expect(merged).toContain(`## Facts\n\n${factsFence}`);
    expect(merged.indexOf(FACTS_FENCE_BEGIN)).toBeLessThan(merged.indexOf('<!-- timeline -->'));
  });

  test('moves a stale timeline-channel facts fence back into compiled truth', () => {
    const current = `# Page\n\n## Facts\n\n${factsFence}\n`;
    const staleRender = `# Page\n\n<!-- timeline -->\n## Timeline\n\n## Facts\n\n${FACTS_FENCE_BEGIN}\nPRIVATE_STALE_FACT\n${FACTS_FENCE_END}\n`;
    const merged = preserveCanonicalFences(staleRender, current);

    expect(merged).not.toContain('PRIVATE_STALE_FACT');
    expect(merged.indexOf(FACTS_FENCE_BEGIN)).toBeLessThan(merged.indexOf('<!-- timeline -->'));
    expect(merged.slice(merged.indexOf('<!-- timeline -->'))).not.toContain(FACTS_FENCE_BEGIN);
  });

  test('current takes fence and heading replace a stale rendered section', () => {
    const current = `# Page\n\n## Takes\n\n${takesFence}\n`;
    const stale = `# Page\n\n## Takes\n\n${TAKES_FENCE_BEGIN}\nPRIVATE_STALE_TAKE\n${TAKES_FENCE_END}\n`;
    const merged = preserveCanonicalFences(stale, current);

    expect(merged).toContain(`## Takes\n\n${takesFence}`);
    expect(merged).not.toContain('PRIVATE_STALE_TAKE');
  });

  test('canonical facts absence removes a stale rendered facts section', () => {
    const current = '# Page\n\nFacts were intentionally deleted.\n';
    const stale = `# Page\n\n## Facts\n\n${FACTS_FENCE_BEGIN}\nPRIVATE_STALE_FACT\n${FACTS_FENCE_END}\n`;
    const merged = preserveCanonicalFences(stale, current);

    expect(merged).not.toContain('## Facts');
    expect(merged).not.toContain(FACTS_FENCE_BEGIN);
    expect(merged).not.toContain('PRIVATE_STALE_FACT');
  });

  test('canonical takes absence removes a stale rendered takes section', () => {
    const current = '# Page\n\nTakes were intentionally deleted.\n';
    const stale = `# Page\n\n## Takes\n\n${TAKES_FENCE_BEGIN}\nPRIVATE_STALE_TAKE\n${TAKES_FENCE_END}\n`;
    const merged = preserveCanonicalFences(stale, current);

    expect(merged).not.toContain('## Takes');
    expect(merged).not.toContain(TAKES_FENCE_BEGIN);
    expect(merged).not.toContain('PRIVATE_STALE_TAKE');
  });

  test('does not insert a managed section inside complete-file frontmatter', () => {
    const current = `---\ntitle: Page\n---\n\n# Page\n\n## Facts\n\n${factsFence}\n`;
    const staleRender = '---\ntitle: Page\n---\n## Timeline\n\n- legacy heading without a split\n';
    const merged = preserveCanonicalFences(staleRender, current);
    const frontmatterEnd = merged.indexOf('\n---\n', 4);

    expect(frontmatterEnd).toBeGreaterThan(0);
    expect(merged.indexOf(FACTS_FENCE_BEGIN)).toBeGreaterThan(frontmatterEnd);
  });
});
