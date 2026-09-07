/** The `e2e init` step that installs the bundled skill for coding agents. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readSkillFiles, SKILL_NAME } from '../skill.ts';

interface SkillLocation {
  /** Project-relative skills directory with `/` separators. */
  readonly dir: string;
  /** The agents that read it, shown as the prompt hint. */
  readonly hint: string;
}

/** Where project skills live: most agents read `.agents/skills`; Claude Code reads `.claude/skills`. */
export const SKILL_LOCATIONS = [
  { dir: '.agents/skills', hint: 'Codex, Cursor, Copilot, Gemini CLI, OpenCode, Zed, and most other agents' },
  { dir: '.claude/skills', hint: 'Claude Code' },
] as const satisfies readonly SkillLocation[];

export interface SkillInstall {
  /** Project-relative skill directory, e.g. `.agents/skills/e2e`. */
  readonly relative: string;
  /** True when the directory already held a copy, so the write is an update. */
  readonly existing: boolean;
  readonly files: readonly { readonly absolute: string; readonly content: string }[];
}

/** Known locations that already hold a copy of the skill. */
export function findInstalledSkillDirs(cwd: string): string[] {
  return SKILL_LOCATIONS.map((location) => location.dir).filter((dir) =>
    existsSync(path.join(cwd, dir, SKILL_NAME, 'SKILL.md')),
  );
}

/**
 * Plans the writes for the given directories. A directory without the skill
 * is created and one whose copy differs from the bundled files is rewritten;
 * an up-to-date copy needs nothing and is left out. Files the bundle does not
 * ship are never removed.
 */
export function planSkillInstall(cwd: string, dirs: readonly string[]): SkillInstall[] {
  const bundled = readSkillFiles();
  const installs: SkillInstall[] = [];
  for (const dir of dirs) {
    const root = path.join(cwd, dir, SKILL_NAME);
    const current = bundled.every((file) => {
      const absolute = path.join(root, file.relative);
      return existsSync(absolute) && readFileSync(absolute, 'utf8') === file.content;
    });
    if (current) continue;
    installs.push({
      relative: `${dir}/${SKILL_NAME}`,
      existing: existsSync(path.join(root, 'SKILL.md')),
      files: bundled.map((file) => ({ absolute: path.join(root, file.relative), content: file.content })),
    });
  }
  return installs;
}
