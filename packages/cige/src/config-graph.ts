/**
 * The files a CIGE config reaches, for `e2e-cige diff`. `diffSince` runs this
 * in its own Node process, the way `e2e-cige` loads the config: plain Node,
 * so `#` imports, package exports, and workspace packages resolve as they
 * do at run time.
 *
 * 1. A resolve hook records every file Node resolves while it imports the
 *    config: the graph it actually loads, aliases included.
 * 2. Each of those files that the repository tracks is read for the
 *    specifiers it names but loading didn't reach, such as a hook's lazy
 *    `await import('#hooks/x')`. Node's resolver resolves each one
 *    (`import.meta.resolve` with a parent, behind
 *    `--experimental-import-meta-resolve`) without running it, and the walk
 *    goes on from there.
 * 3. A dynamic import whose specifier is computed can't be followed, so the
 *    file is reported and the gate blocks.
 *
 * Usage: `node --experimental-import-meta-resolve config-graph.js <config> <root> <tracked.json> <out.json>`.
 * It writes `{ files, computed }` (repo-relative paths) or `{ error }` to
 * `<out.json>`, never to stdout, which belongs to the config's own code.
 * Node's type stripping runs it from source in tests, so it holds to
 * erasable TypeScript.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [config, rootArgument, trackedFile, out] = process.argv.slice(2);
if (config === undefined || rootArgument === undefined || trackedFile === undefined || out === undefined) {
  throw new Error('usage: config-graph <config> <root> <tracked.json> <out.json>');
}
const root = realpathSync(rootArgument);
const listed: unknown = JSON.parse(readFileSync(trackedFile, 'utf8'));
const tracked = new Set(Array.isArray(listed) ? listed.filter((file): file is string => typeof file === 'string') : []);

/** The repo-relative POSIX path of a `file:` URL inside the repository, else undefined. */
function inRepo(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  let file: string;
  try {
    file = realpathSync(fileURLToPath(url));
  } catch {
    return undefined;
  }
  const relative = path.relative(root, file).split(path.sep).join('/');
  return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ? undefined : relative;
}

const loaded = new Set<string>();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    loaded.add(result.url);
    return result;
  },
});

// Comments go first, so a word like "import (lazily)" in one isn't read as a call; `//` after a `:` is a URL, not a comment.
const COMMENTS = /\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g;
const LITERAL = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])([^'"\n]+)\1/g;
const COMPUTED = /\b(?:import|require)\s*\(\s*(?!['"\s)])/g;

let result: { readonly files: string[]; readonly computed: string[] } | { readonly error: string };
try {
  await import(pathToFileURL(config).href);
  const files = new Set<string>();
  const computed: string[] = [];
  const queue = [...loaded].map(inRepo).filter((file): file is string => file !== undefined && tracked.has(file));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (files.has(file)) continue;
    files.add(file);
    const parent = pathToFileURL(path.join(root, file)).href;
    const text = readFileSync(path.join(root, file), 'utf8').replace(COMMENTS, '$1');
    if (COMPUTED.test(text)) computed.push(file);
    COMPUTED.lastIndex = 0;
    for (const match of text.matchAll(LITERAL)) {
      let url: string;
      try {
        url = import.meta.resolve(match[2]!, parent);
      } catch {
        // A specifier that doesn't resolve can't load at run time either: the hook fails, it doesn't pass.
        continue;
      }
      const next = inRepo(url);
      if (next !== undefined && tracked.has(next) && !files.has(next)) queue.push(next);
    }
  }
  result = { files: [...files], computed };
} catch (cause) {
  result = { error: cause instanceof Error ? cause.message.split('\n')[0]! : String(cause) };
}
writeFileSync(out, JSON.stringify(result));
// The config may leave handles open (a server, a timer); the graph is written, so stop here.
process.exit(0);
