/**
 * Checks `examples/examples.json`, the list of examples on
 * https://e2e.tester.army/examples, against `examples/examples.schema.json`
 * and the rules in `examples-registry.ts`.
 *
 * Usage: `node scripts/check-examples.ts [--online]`. `--online` also fetches
 * the README of every example hosted outside this repository, official,
 * partner, or community, which the site renders as the example's page (the
 * folder, for an example with `readme: false`); the `examples-registry` workflow runs it on pull requests that change
 * the registry. Exits 1 listing every problem.
 */

import { readFileSync } from 'node:fs';
import {
  isLocalFolder,
  REGISTRY_PATH,
  type Registry,
  readEnvironment,
  readmeUrl,
  registryProblems,
  schemaProblems,
} from './examples-registry.ts';

async function readmeProblems(registry: Registry): Promise<string[]> {
  const remote = registry.examples.filter((example) => !isLocalFolder(example.repository));
  const results = await Promise.all(
    remote.map(async (example) => {
      // Without a README the page links to the folder, so that is what must exist.
      const url = readmeUrl(example) ?? example.repository;
      try {
        const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
        return response.ok
          ? undefined
          : `examples "${example.slug}": HEAD ${url} answered ${response.status}; ${example.readme === false ? 'is the repository public with that folder?' : example.readme ? 'is the repository public with that file?' : 'is the repository public with a README.md in that folder? Without one, set readme.'}`;
      } catch (error) {
        return `examples "${example.slug}": HEAD ${url} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }),
  );
  return results.filter((problem) => problem !== undefined);
}

let json: unknown;
try {
  json = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
} catch (error) {
  console.error(`examples/examples.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const problems = schemaProblems(json);
if (problems.length === 0) {
  const registry = json as Registry;
  problems.push(...registryProblems(registry, readEnvironment()));
  if (problems.length === 0 && process.argv.includes('--online')) problems.push(...(await readmeProblems(registry)));
}

if (problems.length > 0) {
  console.error(`examples/examples.json has ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
const count = (json as Registry).examples.length;
console.log(`examples/examples.json: ${count} examples OK`);
