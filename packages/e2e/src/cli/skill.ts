/** The bundled agent skill: `SKILL.md` plus one reference file per `e2e guide` topic. */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'e2e';

/** Printed when a build or an install left the skill files out of the package. */
export const MISSING_SKILL_MESSAGE = 'this installation ships no skill files; reinstall e2e';

const TOPIC_PREFIX = 'references/';

/**
 * The published package ships the skill at `<package>/skills/e2e`, copied from
 * the repository's `skills/e2e` by the build. That copy is tried first so a
 * user project's own `skills/` directory is never mistaken for it; inside the
 * repository the source directory is read directly, so nothing here needs a
 * build. Undefined only for a broken installation.
 */
function skillDirectory(): string | undefined {
  for (const candidate of ['../../skills/e2e/', '../../../../skills/e2e/']) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return undefined;
}

export interface SkillFile {
  /** Path relative to the skill root with `/` separators. */
  readonly relative: string;
  readonly content: string;
}

let cached: readonly SkillFile[] | undefined;

/** Every file of the skill, `SKILL.md` first, or none when the installation lacks it. */
export function readSkillFiles(): readonly SkillFile[] {
  // Package files do not change while the process runs.
  return cached ??= loadSkillFiles();
}

/** Walks the installed skill directory. */
function loadSkillFiles(): readonly SkillFile[] {
  const root = skillDirectory();
  if (root === undefined) return [];
  const files: SkillFile[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push({ relative: path.relative(root, absolute).split(path.sep).join('/'), content: readFileSync(absolute, 'utf8') });
    }
  };
  walk(root);
  return [...files.filter((file) => file.relative === 'SKILL.md'), ...files.filter((file) => file.relative !== 'SKILL.md')];
}

/** Topics `e2e guide <topic>` accepts: one per `references/<topic>.md`. */
export function skillTopics(): readonly string[] {
  return readSkillFiles()
    .filter((file) => file.relative.startsWith(TOPIC_PREFIX) && file.relative.endsWith('.md'))
    .map((file) => file.relative.slice(TOPIC_PREFIX.length, -'.md'.length));
}

/** The overview (`SKILL.md` without its frontmatter) or one topic's text; undefined for an unknown topic. */
export function readGuide(topic: string | undefined): string | undefined {
  const files = readSkillFiles();
  if (topic === undefined) {
    return files.find((file) => file.relative === 'SKILL.md')?.content.replace(/^---\n[\s\S]*?\n---\n+/, '');
  }
  return files.find((file) => file.relative === `${TOPIC_PREFIX}${topic}.md`)?.content;
}
