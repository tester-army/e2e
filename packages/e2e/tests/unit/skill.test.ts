import { readdirSync, readFileSync } from 'node:fs';
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
    expect(topics).toEqual(['agent', 'bug-bash', 'debugging', 'explore', 'mcp', 'running', 'setup', 'writing-tests']);
    const overview = readGuide(undefined) ?? '';
    const linked = [...overview.matchAll(/\[references\/([a-z-]+)\.md\]\(references\/\1\.md\)/g)].map((match) => match[1]);
    expect(linked.toSorted()).toEqual([...topics]);
    for (const topic of topics) expect(overview).toContain(`| \`${topic}\` |`);
  });

  it('prints the overview without its frontmatter and each topic verbatim', () => {
    const overview = readGuide(undefined) ?? '';
    expect(overview.startsWith('# e2e')).toBe(true);
    expect(overview).not.toContain('\n---\n');
    expect(overview).toContain('npx e2e guide <topic>');
    for (const topic of skillTopics()) {
      const text = readGuide(topic) ?? '';
      expect(text.startsWith('# ')).toBe(true);
      expect(readSkillFiles().find((file) => file.relative === `references/${topic}.md`)?.content).toBe(text);
    }
    expect(readGuide('nope')).toBeUndefined();
    expect(readGuide('../SKILL')).toBeUndefined();
  });

  it('runs the installed CLI as npx e2e, without --no-install or the scoped package name', () => {
    for (const file of readSkillFiles()) {
      expect(file.content, file.relative).not.toMatch(/--no-install/);
      expect(file.content, file.relative).not.toMatch(/npx @e2edev\/e2e (run|guide)\b/);
    }
  });

  it('ships in the published package through the build copy', () => {
    expect(packageJson.files).toContain('skills');
    expect(packageJson.scripts['build']).toContain("cpSync('../../skills/e2e','skills/e2e'");
  });
});

/** The skill sources and the docs pages, relative to the repository root, each with its text. */
function userFacingPages(): { file: string; text: string }[] {
  const root = new URL('../../../../', import.meta.url);
  return ['skills/e2e', 'docs']
    .flatMap((dir) =>
      readdirSync(new URL(dir, root), { recursive: true, encoding: 'utf8' })
        .filter((file) => /\.mdx?$/.test(file) && !file.includes('node_modules'))
        .map((file) => `${dir}/${file}`),
    )
    .map((file) => ({ file, text: readFileSync(new URL(file, root), 'utf8') }));
}

describe('the skill and the docs', () => {
  it('never name the removed --artifacts in the skill, which agents would copy', () => {
    for (const { file, text } of userFacingPages().filter((page) => page.file.startsWith('skills/'))) {
      expect(text, file).not.toContain('--artifacts');
    }
  });

  it('pass --artifacts only in a paragraph that says the flag is gone', () => {
    for (const { file, text } of userFacingPages()) {
      for (const paragraph of text.split(/\n\s*\n/).filter((block) => block.includes('--artifacts'))) {
        expect(paragraph, file).toMatch(/removed|gone/);
      }
    }
  });
});
