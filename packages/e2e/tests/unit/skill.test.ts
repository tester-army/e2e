import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readGuide, readSkillFiles, skillTopics } from '../../src/cli/skill.ts';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  files: string[];
  scripts: Record<string, string>;
};

describe('the bundled agent skill', () => {
  it('starts with a SKILL.md whose frontmatter names the skill after its directory', () => {
    const [skill, ...rest] = readSkillFiles();
    expect(skill?.relative).toBe('SKILL.md');
    expect(skill?.content).toMatch(/^---\nname: e2e\ndescription: .+\n---\n/);
    expect(rest.map((file) => file.relative)).toEqual(skillTopics().map((topic) => `references/${topic}.md`));
    const description = /^description: (.+)$/m.exec(skill?.content ?? '')?.[1] ?? '';
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toContain(': ');
  });

  it('offers one topic per reference file and lists every topic in SKILL.md', () => {
    const topics = skillTopics();
    expect(topics).toEqual(['agent', 'debugging', 'running', 'setup', 'writing-tests']);
    const overview = readGuide(undefined) ?? '';
    const linked = [...overview.matchAll(/\[references\/([a-z-]+)\.md\]\(references\/\1\.md\)/g)].map((match) => match[1]);
    expect(linked.toSorted()).toEqual([...topics]);
    for (const topic of topics) expect(overview).toContain(`| \`${topic}\` |`);
  });

  it('prints the overview without its frontmatter and each topic verbatim', () => {
    const overview = readGuide(undefined) ?? '';
    expect(overview.startsWith('# e2e')).toBe(true);
    expect(overview).not.toContain('\n---\n');
    expect(overview).toContain('npx --no-install e2e guide <topic>');
    for (const topic of skillTopics()) {
      const text = readGuide(topic) ?? '';
      expect(text.startsWith('# ')).toBe(true);
      expect(readSkillFiles().find((file) => file.relative === `references/${topic}.md`)?.content).toBe(text);
    }
    expect(readGuide('nope')).toBeUndefined();
    expect(readGuide('../SKILL')).toBeUndefined();
  });

  it('never documents a bare npx e2e', () => {
    for (const file of readSkillFiles()) {
      expect(file.content, file.relative).not.toMatch(/npx e2e\b/);
      expect(file.content, file.relative).not.toMatch(/npx @e2edev\/e2e (run|guide)\b/);
    }
  });

  it('ships in the published package through the build copy', () => {
    expect(packageJson.files).toContain('skills');
    expect(packageJson.scripts['build']).toContain("cpSync('../../skills/e2e','skills/e2e'");
  });
});
