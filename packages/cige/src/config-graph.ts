/**
 * The files a CIGE config reaches, for `e2e-cige diff`. `diffSince` runs this
 * in its own Node process, the way `e2e-cige` loads the config: plain Node,
 * so `#` imports, package exports, and workspace packages resolve as they
 * do at run time.
 *
 * 1. A resolve hook records every file Node resolves while it imports the
 *    config: the graph it actually loads, aliases included.
 * 2. Each of those files that git lists, inside the repository and outside
 *    `node_modules`, is parsed (`imports.ts`) for the specifiers it names but loading didn't
 *    reach, such as a hook's lazy `await import('#hooks/x')`. Node's
 *    resolver resolves each one (`import.meta.resolve` with a parent,
 *    behind `--experimental-import-meta-resolve`) without running it, and
 *    the walk goes on from there. A file whose imports can't all be read,
 *    such as a computed `import(name)`, is reported and the gate blocks.
 * 3. A loaded file git doesn't list, such as a workspace package built to
 *    an ignored `dist`, isn't parsed: its package's sources stand for it,
 *    and every listed file under that package's package.json counts. One with no package of its own
 *    apart from the config's can't be traced to a source, so it blocks.
 * 4. A listed symlink to a graph file, or to a directory above one, counts:
 *    Node reads through it, so retargeting it changes what loads.
 * 5. The nearest package.json of each file is reported too: its `imports`
 *    and `exports` decide where an alias lands, so remapping one can
 *    redirect a hook to another file without touching either.
 * 6. The config at the merge base is walked by text too (its relative
 *    imports), so a module the branch deleted or renamed still counts.
 *
 * Usage: `node --experimental-import-meta-resolve config-graph.js <input.json> <out.json>`.
 * It writes `{ files, manifests, base, unverified }` (repo-relative paths)
 * to `<out.json>`, never to stdout, which belongs to the config's own code.
 * Node's type stripping runs it from source in tests, so it holds to
 * erasable TypeScript.
 */

import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

import { importsOf } from './imports.ts';
import { outside, treeAt, type TreeSide } from './tree.ts';

const INPUT = z.object({
  /** The config to load, absolute, or null when the working tree has none. */
  config: z.string().nullable(),
  root: z.string(),
  mergeBase: z.string(),
  /** Where the config may be, repo-relative, in order. */
  candidates: z.array(z.string()),
  /** Every file git lists in the working tree: tracked, and untracked but not ignored. */
  listed: z.array(z.string()),
});

const [inputFile, out] = process.argv.slice(2);
if (inputFile === undefined || out === undefined) throw new Error('usage: config-graph <input.json> <out.json>');
const input = INPUT.parse(JSON.parse(readFileSync(inputFile, 'utf8')));
const root = realpathSync(input.root);
const listed = new Set(input.listed);

const MODULE_EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];
const SOURCE = /\.[cm]?[jt]s$/;

/**
 * The config file and every local module it imports, transitively, at the
 * merge base: specifiers that start with `.`, resolved beside the importing
 * file, inside the repository only. The walk starts from the first
 * candidate the base has. A file that doesn't parse adds nothing: this side
 * only adds what the branch deleted or renamed, and the working tree's
 * graph covers the rest.
 */
function configModules(candidates: readonly string[], entry: TreeSide): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    const found = entry(file);
    if (found === undefined) return;
    seen.add(file);
    // Node imports a symlinked module from its real path, so a link counts (retargeting it is a change) and so does its target.
    if ('target' in found) {
      if (found.target !== undefined) visit(found.target);
      return;
    }
    for (const specifier of importsOf(found.text, file).specifiers) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const target = path.posix.join(path.posix.dirname(file), specifier);
      if (outside(target)) continue;
      const resolved = MODULE_EXTENSIONS.map((extension) => `${target}${extension}`).find((candidate) => entry(candidate) !== undefined);
      if (resolved !== undefined) visit(resolved);
    }
  };
  const first = candidates.find((file) => entry(file) !== undefined);
  if (first !== undefined) visit(first);
  return [...seen];
}

/** The repo-relative POSIX path of a `file:` URL inside the repository, through any link, else undefined. */
function inRepo(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  let file: string;
  try {
    file = realpathSync(fileURLToPath(url));
  } catch {
    return undefined;
  }
  const relative = path.relative(root, file).split(path.sep).join('/');
  return relative === '' || outside(relative) || path.isAbsolute(relative) ? undefined : relative;
}

/** Installed packages are reviewed as dependencies, not as the case. */
function installed(file: string): boolean {
  return file.split('/').includes('node_modules');
}

/** The package.json Node reads for a file's `imports` and its package's `exports`: the nearest listed one up to the root. */
function nearestManifest(file: string): string | undefined {
  for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
    const manifest = directory === '.' ? 'package.json' : `${directory}/package.json`;
    if (listed.has(manifest)) return manifest;
    if (directory === '.') return undefined;
  }
}

const loaded = new Set<string>();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    loaded.add(result.url);
    return result;
  },
});

const base = configModules(input.candidates, treeAt(input.mergeBase, root));
const files = new Set<string>();
const unverified: string[] = [];
if (input.config !== null) {
  try {
    await import(pathToFileURL(input.config).href);
  } catch (cause) {
    unverified.push(`loading it failed: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`);
  }
}
if (input.config !== null && unverified.length === 0) {
  const configFile = inRepo(pathToFileURL(input.config).href);
  const ownPackage = configFile === undefined ? undefined : nearestManifest(configFile);
  const walked = new Set<string>();
  const queue = [...loaded].map(inRepo).filter((file): file is string => file !== undefined && !installed(file));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (walked.has(file)) continue;
    walked.add(file);
    if (!listed.has(file)) {
      // Built output git ignores, such as a workspace package's dist: its package's listed sources stand for it, so it isn't parsed.
      const manifest = nearestManifest(file);
      if (manifest === undefined || manifest === 'package.json' || manifest === ownPackage) {
        unverified.push(`loads ${file}, which git doesn't track`);
      } else {
        const directory = `${path.posix.dirname(manifest)}/`;
        for (const source of listed) if (source.startsWith(directory)) files.add(source);
      }
      continue;
    }
    files.add(file);
    if (!SOURCE.test(file)) continue;
    const imports = importsOf(readFileSync(path.join(root, file), 'utf8'), file);
    if (imports.unverified !== undefined) unverified.push(`${file} ${imports.unverified}`);
    const parent = pathToFileURL(path.join(root, file)).href;
    for (const specifier of imports.specifiers) {
      let url: string;
      try {
        url = import.meta.resolve(specifier, parent);
      } catch {
        // A specifier that doesn't resolve can't load at run time either: the hook fails, it doesn't pass.
        continue;
      }
      const next = inRepo(url);
      if (next !== undefined && !installed(next) && !walked.has(next)) queue.push(next);
    }
  }
  // Node reads through links to real paths, so the graph holds targets; a listed link to one is how a retarget shows.
  const graph = [...files];
  for (const file of listed) {
    let link = false;
    try {
      link = lstatSync(path.join(root, file)).isSymbolicLink();
    } catch {
      continue;
    }
    if (!link) continue;
    const target = inRepo(pathToFileURL(path.join(root, file)).href);
    if (target !== undefined && graph.some((reached) => reached === target || reached.startsWith(`${target}/`))) files.add(file);
  }
}
const manifests = new Set([...files].map(nearestManifest).filter((manifest): manifest is string => manifest !== undefined));
writeFileSync(out, JSON.stringify({ files: [...files], manifests: [...manifests], base, unverified }));
// The config may leave handles open (a server, a timer); the graph is written, so stop here.
process.exit(0);
