/** The `e2e init` step that installs the bundled skill for coding agents. */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
import { insideProjectRoot, realpathOfExisting } from '../../internal/paths.ts';
import { MISSING_SKILL_MESSAGE, SKILL_NAME, type SkillFile } from '../skill.ts';

interface SkillLocation {
  /** Project-relative skills directory with `/` separators. */
  readonly dir: string;
  /** The agents that read it, shown as the prompt hint. */
  readonly hint: string;
  /**
   * The location whose copy this one links to when both are chosen, so one
   * copy serves every agent: the layout `npx skills add` produces.
   */
  readonly linksTo?: string;
}

/** Where project skills live: most agents read `.agents/skills`; Claude Code reads `.claude/skills`. */
export const SKILL_LOCATIONS: readonly SkillLocation[] = [
  { dir: '.agents/skills', hint: 'Codex, Cursor, Copilot, Gemini CLI, OpenCode, Zed, and most other agents' },
  { dir: '.claude/skills', hint: 'Claude Code, as a symlink into .agents/skills when both are chosen', linksTo: '.agents/skills' },
];

/** A symlink on the way to a skill file. */
interface SkillLink {
  /** Project-relative path of the link with `/` separators, e.g. `.claude/skills/e2e`. */
  readonly relative: string;
  /** Absolute path the link leads to; the path as written when it dangles. */
  readonly target: string;
}

/** An entry a write cannot pass: a directory where a bundled file goes, or a file where its directory goes. */
interface SkillObstacle {
  /** Path relative to the skill directory with `/` separators, e.g. `SKILL.md`. */
  readonly relative: string;
  readonly kind: 'directory' | 'file';
}

interface SkillInstallBase {
  /** Project-relative skill directory, e.g. `.agents/skills/e2e`. */
  readonly relative: string;
  /** True when the directory already holds a copy: a copy updates it, a link replaces it. */
  readonly existing: boolean;
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

/** The bundled files, written into the skill directory. */
interface SkillCopy extends SkillInstallBase {
  readonly kind: 'copy';
  readonly files: readonly { readonly absolute: string; readonly content: string }[];
}

/** A symlink standing in for the skill directory, leading to the copy in another location. */
interface SkillSymlink extends SkillInstallBase {
  readonly kind: 'link';
  /** The link as written, relative to its parent with `/` separators: `../../.agents/skills/e2e`. */
  readonly target: string;
}

export type SkillInstall = SkillCopy | SkillSymlink;

/**
 * Known locations that hold a copy of the skill. The directory is the marker,
 * not `SKILL.md`, so a copy that lost files is repaired rather than ignored.
 */
export function findInstalledSkillDirs(cwd: string): string[] {
  return SKILL_LOCATIONS.map((location) => location.dir).filter((dir) => existsSync(path.join(cwd, dir, SKILL_NAME)));
}

/** The chosen directories split into the ones written as a copy and the ones linked to a copy among them. */
export function splitSkillDirs(dirs: readonly string[]): { copies: string[]; links: { dir: string; linksTo: string }[] } {
  const links = SKILL_LOCATIONS.flatMap((location) =>
    location.linksTo !== undefined && dirs.includes(location.dir) && dirs.includes(location.linksTo)
      ? [{ dir: location.dir, linksTo: location.linksTo }]
      : [],
  );
  return { copies: dirs.filter((dir) => !links.some((link) => link.dir === dir)), links };
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
    installs.push({ kind: 'copy', relative: `${dir}/${SKILL_NAME}`, existing: existsSync(root), files, links, obstacles });
  }
  return installs;
}

/**
 * Whether a directory holds the copy once the planned writes are done: its
 * plan goes ahead, or nothing was planned because the copy is current.
 */
export function holdsCopyAfter(dir: string, planned: readonly SkillInstall[], going: readonly SkillInstall[]): boolean {
  const relative = `${dir}/${SKILL_NAME}`;
  return going.some((install) => install.relative === relative) || !planned.some((install) => install.relative === relative);
}

/**
 * Plans `dir` as a symlink to the copy in `canonicalDir`, which `ready` says
 * this run leaves in place. Nothing is planned for an entry that already
 * leads there, the link itself or a linked parent. A copy holding only
 * bundled files is replaced by the link, since the copy it leads to has the
 * same content; one holding anything else, like a location whose copy is not
 * ready, is planned as a copy like any other. A symlink leading elsewhere,
 * or one on the way, is planned with what was met, for the caller to skip or
 * replace.
 */
export function planSkillLink(
  cwd: string,
  dir: string,
  canonicalDir: string,
  bundled: readonly SkillFile[],
  ready: boolean,
): SkillInstall | undefined {
  const link = path.join(cwd, dir, SKILL_NAME);
  const canonical = path.join(cwd, canonicalDir, SKILL_NAME);
  if (ready && leadsTo(link, canonical)) return undefined;
  const entry = lstatOrUndefined(link);
  const linkable = entry === undefined || entry.isSymbolicLink() || (entry.isDirectory() && holdsOnlyBundled(link, bundled));
  if (!ready || !linkable) return planSkillInstall(cwd, [dir], bundled)[0];
  const blocker = firstBlocker(cwd, path.dirname(link), 'directory')
    ?? (entry?.isSymbolicLink() ? { kind: 'link' as const, absolute: link } : undefined);
  const found = describeBlocker(cwd, link, link, blocker);
  return {
    kind: 'link',
    relative: `${dir}/${SKILL_NAME}`,
    existing: entry?.isDirectory() === true,
    target: posixRelative(path.dirname(link), canonical),
    links: found !== undefined && 'link' in found ? [found.link] : [],
    obstacles: found !== undefined && 'obstacle' in found ? [found.obstacle] : [],
  };
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

/**
 * Whether `link` already leads to `canonical`: it resolves there through the
 * filesystem, a linked parent included, or it is a symlink written to point
 * there whose target does not exist yet.
 */
function leadsTo(link: string, canonical: string): boolean {
  return realpathOfExisting(link) === realpathOfExisting(canonical);
}

/**
 * Whether the directory holds nothing but regular files the bundle ships, so a
 * link to another copy loses nothing. A symlink inside is a link to respect
 * under the copy rules, never a file to drop.
 */
function holdsOnlyBundled(root: string, bundled: readonly SkillFile[]): boolean {
  const shipped = bundled.map((file) => file.relative);
  return readdirSync(root, { recursive: true, withFileTypes: true }).every((entry) => {
    const relative = posixRelative(root, path.join(entry.parentPath, entry.name));
    return entry.isDirectory() ? shipped.some((file) => file.startsWith(`${relative}/`)) : entry.isFile() && shipped.includes(relative);
  });
}

type Blocker = { readonly kind: 'link' | SkillObstacle['kind']; readonly absolute: string };

/**
 * What stands between the project root and the given files, each once: the
 * first symlink on a path (components past it live wherever it points and are
 * not inspected), a file that resolves outside the project without one, and
 * the entries a write cannot pass.
 */
function findBlockers(cwd: string, root: string, files: readonly string[]): Pick<SkillInstallBase, 'links' | 'obstacles'> {
  const links = new Map<string, SkillLink>();
  const obstacles = new Map<string, SkillObstacle>();
  for (const file of files) {
    const found = describeBlocker(cwd, root, file, firstBlocker(cwd, file, 'file'));
    if (found === undefined) continue;
    if ('link' in found) links.set(found.link.relative, found.link);
    else obstacles.set(found.obstacle.relative, found.obstacle);
  }
  return { links: [...links.values()], obstacles: [...obstacles.values()] };
}

/**
 * A blocker as the plan spells it: a symlink with where it leads, the entry
 * a write cannot pass relative to the skill directory, or, with no blocker
 * on the path, `file` itself when it resolves outside the project.
 */
function describeBlocker(
  cwd: string,
  root: string,
  file: string,
  blocker: Blocker | undefined,
): { link: SkillLink } | { obstacle: SkillObstacle } | undefined {
  if (blocker === undefined) {
    if (insideProjectRoot(cwd, file)) return undefined;
    return { link: { relative: posixRelative(cwd, file), target: realpathOfExisting(file) } };
  }
  if (blocker.kind === 'link') return { link: { relative: posixRelative(cwd, blocker.absolute), target: linkTarget(blocker.absolute) } };
  return { obstacle: { relative: posixRelative(root, blocker.absolute), kind: blocker.kind } };
}

/**
 * The first entry from the project root down to `target`, wanted as a file
 * or as a directory, that a write cannot go through as planned.
 */
function firstBlocker(cwd: string, target: string, wants: 'file' | 'directory'): Blocker | undefined {
  const segments = path.relative(cwd, target).split(path.sep);
  let current = cwd;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = lstatOrUndefined(current);
    if (entry === undefined) return undefined;
    if (entry.isSymbolicLink()) return { kind: 'link', absolute: current };
    const wantsFile = wants === 'file' && index === segments.length - 1;
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
