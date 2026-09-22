/** The `e2e init` step that installs the bundled skill for coding agents. */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { insideProjectRoot, realpathOfExisting } from '../../internal/paths.ts';
import { MISSING_SKILL_MESSAGE, SKILL_NAME, type SkillFile } from '../skill.ts';

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

/** A symlink on the way to a skill file. */
export interface SkillLink {
  /** Project-relative path of the link with `/` separators, e.g. `.claude/skills/e2e`. */
  readonly relative: string;
  /** Absolute path the link leads to; the path as written when it dangles. */
  readonly target: string;
}

export interface SkillInstall {
  /** Project-relative skill directory, e.g. `.agents/skills/e2e`. */
  readonly relative: string;
  /** True when the directory already held a copy, so the write is an update. */
  readonly existing: boolean;
  readonly files: readonly { readonly absolute: string; readonly content: string }[];
  /**
   * The symlinks between the project root and the files, each once, plus any
   * file that resolves outside the project without one. Init never writes
   * through them: a link to a dotfiles repo or a shared skills folder would
   * be overwritten there.
   */
  readonly links: readonly SkillLink[];
}

/**
 * Known locations that hold a copy of the skill. The directory is the marker,
 * not `SKILL.md`, so a copy that lost files is repaired rather than ignored.
 */
export function findInstalledSkillDirs(cwd: string): string[] {
  return SKILL_LOCATIONS.map((location) => location.dir).filter((dir) => existsSync(path.join(cwd, dir, SKILL_NAME)));
}

/**
 * Plans the writes for the given directories from the bundled files. A
 * directory without the skill is created and one whose copy differs from the
 * bundle is rewritten; an up-to-date copy needs nothing and is left out. Files
 * the bundle does not ship are never removed. A location reached through a
 * symlink is planned with its links, for the caller to skip or replace. An
 * empty bundle with somewhere to write is a broken installation, never a set
 * of current copies.
 */
export function planSkillInstall(cwd: string, dirs: readonly string[], bundled: readonly SkillFile[]): SkillInstall[] {
  if (dirs.length > 0 && bundled.length === 0) throw new Error(MISSING_SKILL_MESSAGE);
  const installs: SkillInstall[] = [];
  for (const dir of dirs) {
    const root = path.join(cwd, dir, SKILL_NAME);
    const files = bundled.map((file) => ({ absolute: path.join(root, file.relative), content: file.content }));
    const current = files.every((file) => existsSync(file.absolute) && readFileSync(file.absolute, 'utf8') === file.content);
    if (current) continue;
    installs.push({
      relative: `${dir}/${SKILL_NAME}`,
      existing: existsSync(root),
      files,
      links: findLinks(cwd, files.map((file) => file.absolute)),
    });
  }
  return installs;
}

/**
 * Whether removing the install's links leaves everything but the skill in
 * place: each is the skill directory or inside it. A linked parent
 * (`.claude/skills`) holds more than the skill, so a copy cannot stand in
 * for it.
 */
export function replaceableLinks(install: SkillInstall): boolean {
  return install.links.every((link) => link.relative.startsWith(install.relative));
}

/**
 * The install's links for a message: a skill directory that is itself the
 * link reads `dir -> target`; otherwise the directory, then the links in
 * parentheses.
 */
export function describeLinks(install: SkillInstall): string {
  const links = install.links.map((link) => `${link.relative} -> ${link.target}`).join(', ');
  const [only] = install.links;
  return install.links.length === 1 && only?.relative === install.relative ? links : `${install.relative}/ (${links})`;
}

/**
 * The symlinks between the project root and the given files, each once.
 * Components past a link are never inspected: they live wherever the link
 * points. A file that resolves outside the project without a link on the way
 * is listed as its own link.
 */
function findLinks(cwd: string, files: readonly string[]): SkillLink[] {
  const links = new Map<string, string>();
  for (const file of files) {
    let current = cwd;
    let linked = false;
    for (const segment of path.relative(cwd, file).split(path.sep)) {
      current = path.join(current, segment);
      if (!isSymlink(current)) continue;
      links.set(current, linkTarget(current));
      linked = true;
      break;
    }
    if (!linked && !insideProjectRoot(cwd, file)) links.set(file, realpathOfExisting(file));
  }
  return [...links].map(([absolute, target]) => ({ relative: path.relative(cwd, absolute).split(path.sep).join('/'), target }));
}

/** Whether the entry at `target` is a symlink; a missing or unreachable entry is not. */
function isSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Where a symlink leads: its real path, or the path as written when it dangles. */
function linkTarget(link: string): string {
  return existsSync(link) ? realpathSync(link) : path.resolve(path.dirname(link), readlinkSync(link));
}
