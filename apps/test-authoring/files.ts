import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Hashes bytes with SHA-256. */
export function hash(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Writes a new file, or rejects an existing file with different bytes. */
export function freeze(path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (!readFileSync(path).equals(Buffer.from(bytes))) throw new Error(`Conflicting immutable file ${path}`);
    return;
  }
  writeFileSync(path, bytes, { flag: 'wx' });
}

/** Reads JSON at a file boundary. Callers validate its shape. */
export function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Serializes the same in-memory domain shape consistently. */
export function encode(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** Records regular files and contained links without following links. */
export function tree(root: string): Record<string, string> {
  root = realpathSync(root);
  const files: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).toSorted()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const inside = relative(root, realpathSync(path));
        if (inside.startsWith('..') || resolve(root, inside) === root) throw new Error(`External dependency link ${path}`);
        files[relative(root, path)] = hash(`link:${target}`);
      } else if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files[relative(root, path)] = hash(readFileSync(path));
      else throw new Error(`Unsupported file ${path}`);
    }
  };
  visit(root);
  return files;
}

/** Copies a prepared tree with links that remain inside its new location. */
export function copy(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
}

/** Runs a command without inheriting service credentials or subscription stores. */
export function command(cwd: string, executable: string, args: string[], timeout = 60000) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(cwd, '.home'), TMPDIR: process.env.TMPDIR, SystemRoot: process.env.SystemRoot, CI: '1', E2E_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  else env.PLAYWRIGHT_BROWSERS_PATH = join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  mkdirSync(env.HOME!, { recursive: true });
  return spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
}

/** Copies public built packages and their installed dependency closure, never repository sources. */
export function bundle(destination: string): void {
  const copied = new Map<string, string>();
  const locate = (start: string, name: string): string => {
    let directory = start;
    while (true) {
      const path = join(directory, 'node_modules', name);
      if (existsSync(join(path, 'package.json'))) return realpathSync(path);
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Missing installed dependency ${name}`);
      directory = parent;
    }
  };
  const materialize = (source: string): string => {
    const previous = copied.get(source);
    if (previous) return previous;
    const manifest = json(join(source, 'package.json')) as { name: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };
    const target = join(destination, '.store', hash(source).slice(0, 16), 'package');
    copied.set(source, target);
    mkdirSync(target, { recursive: true });
    const publicFiles = manifest.name === 'e2e' ? ['package.json', 'dist', 'docs', 'schema', 'skills', 'NOTICE'] : manifest.name === '@e2e-dev/web' ? ['package.json', 'dist', 'NOTICE'] : readdirSync(source).filter(name => name !== 'node_modules' && name !== '.git');
    for (const name of publicFiles) if (existsSync(join(source, name))) copy(join(source, name), join(target, name));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).toSorted()) {
      if (manifest.peerDependenciesMeta?.[name]?.optional) continue;
      let dependency: string;
      try { dependency = locate(source, name); } catch (error) {
        if (manifest.dependencies?.[name]) throw error;
        continue;
      }
      const link = join(target, 'node_modules', name);
      const installed = materialize(dependency);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(relative(dirname(link), installed), link, 'dir');
    }
    return target;
  };
  for (const name of ['e2e', '@e2e-dev/web']) {
    const target = materialize(realpathSync(join(repo, 'packages', name === 'e2e' ? 'e2e' : 'web')));
    const link = join(destination, name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), target), link, 'dir');
  }
  tree(destination);
}
