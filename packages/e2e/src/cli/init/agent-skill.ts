/** The `e2e init` step that installs the bundled skill for coding agents. */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
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

/** An entry a write cannot pass: a directory where a bundled file goes, or a file where its directory goes. */
export interface SkillObstacle {
  /** Path relative to the skill directory with `/` separators, e.g. `SKILL.md`. */
  readonly relative: string;
  readonly kind: 'directory' | 'file';
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
  /** Entries the writes would fail on, each once; removing them is not a repair init makes. */
  readonly obstacles: readonly SkillObstacle[];
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
 * symlink, or holding an entry a write cannot pass, is planned with what was
 * met and never read, for the caller to skip or replace. An empty bundle with
 * somewhere to write is a broken installation, never a set of current copies.
 */
export function planSkillInstall(cwd: string, dirs: readonly string[], bundled: readonly SkillFile[]): SkillInstall[] {
  if (dirs.length > 0 && bundled.length === 0) throw new Error(MISSING_SKILL_MESSAGE);
  const installs: SkillInstall[] = [];
  for (const dir of dirs) {
    const root = path.join(cwd, dir, SKILL_NAME);
    const files = bundled.map((file) => ({ absolute: path.join(root, file.relative), content: file.content }));
    const { links, obstacles } = findBlockers(cwd, root, files.map((file) => file.absolute));
    const current = links.length === 0 && obstacles.length === 0
      && files.every((file) => currentContent(file.absolute) === file.content);
    if (current) continue;
    installs.push({ relative: `${dir}/${SKILL_NAME}`, existing: existsSync(root), files, links, obstacles });
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

/** The install's obstacles for a message: the directory, then each entry and what it is in parentheses. */
export function describeObstacles(install: SkillInstall): string {
  return `${install.relative}/ (${install.obstacles.map((obstacle) => `${obstacle.relative} is a ${obstacle.kind}`).join(', ')})`;
}

/** The content a bundled file currently has, or undefined when it cannot be read as a file, which differs from any bundle. */
function currentContent(absolute: string): string | undefined {
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

type Blocker = { readonly kind: 'link' | SkillObstacle['kind']; readonly absolute: string };

/**
 * What stands between the project root and the given files, each once: the
 * first symlink on a path (components past it live wherever it points and are
 * not inspected), a file that resolves outside the project without one, and
 * the entries a write cannot pass.
 */
function findBlockers(cwd: string, root: string, files: readonly string[]): Pick<SkillInstall, 'links' | 'obstacles'> {
  const links = new Map<string, string>();
  const obstacles = new Map<string, SkillObstacle['kind']>();
  for (const file of files) {
    const blocker = firstBlocker(cwd, file);
    if (blocker === undefined) {
      if (!insideProjectRoot(cwd, file)) links.set(file, realpathOfExisting(file));
    } else if (blocker.kind === 'link') {
      links.set(blocker.absolute, linkTarget(blocker.absolute));
    } else {
      obstacles.set(blocker.absolute, blocker.kind);
    }
  }
  return {
    links: [...links].map(([absolute, target]) => ({ relative: posixRelative(cwd, absolute), target })),
    obstacles: [...obstacles].map(([absolute, kind]) => ({ relative: posixRelative(root, absolute), kind })),
  };
}

/** The first entry from the project root down to `file` that a write cannot go through as planned. */
function firstBlocker(cwd: string, file: string): Blocker | undefined {
  const segments = path.relative(cwd, file).split(path.sep);
  let current = cwd;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = lstatOrUndefined(current);
    if (entry === undefined) return undefined;
    if (entry.isSymbolicLink()) return { kind: 'link', absolute: current };
    const wantsFile = index === segments.length - 1;
    if (wantsFile && entry.isDirectory()) return { kind: 'directory', absolute: current };
    if (!wantsFile && !entry.isDirectory()) return { kind: 'file', absolute: current };
  }
  return undefined;
}

/** The entry at `target` without following a final symlink; undefined when missing or unreachable. */
function lstatOrUndefined(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

/** Where a symlink leads: its real path, or the path as written when it dangles. */
function linkTarget(link: string): string {
  return existsSync(link) ? realpathSync(link) : path.resolve(path.dirname(link), readlinkSync(link));
}

/** `absolute` relative to `from` with `/` separators, as the messages and the plan spell paths. */
function posixRelative(from: string, absolute: string): string {
  return path.relative(from, absolute).split(path.sep).join('/');
}
