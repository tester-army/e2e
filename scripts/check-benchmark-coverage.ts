/**
 * Fails when a benchmark scenario ships without its test.
 *
 * `apps/web-benchmark/README.md` promises every scenario a deterministic twin
 * (`tests/<slug>.e2e.ts`), and `apps/mobile-benchmark/README.md` promises one
 * `agent.act` per scenario. Nothing checked either promise, so a scenario
 * added to a catalog could ship untested with both suites green — `file-round-trip`
 * did exactly that until its twin landed.
 *
 * The web side stays deterministic-twin only: the web agentic suite is
 * intentionally partial (about a third of the scenarios have no agentic
 * entry, by design), so no web agentic check exists. The mobile side checks
 * the agentic list with the one documented hole, the Control Inventory the
 * agentic suite deliberately leaves out; a new hole needs a written reason.
 *
 * Usage: `node scripts/check-benchmark-coverage.ts`, part of `pnpm check`.
 * Exits 1 listing every gap.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileNames, mobileProblems, webProblems, webSlugs } from './benchmark-coverage.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Mobile names the agentic suite deliberately leaves out, from `apps/mobile-benchmark/README.md`. */
const MOBILE_WITHOUT_AGENT = ['Control Inventory'];

const webDir = join(ROOT, 'apps', 'web-benchmark');
const mobileDir = join(ROOT, 'apps', 'mobile-benchmark');

const webSource = readFileSync(join(webDir, 'app', 'src', 'examples.ts'), 'utf8');
const testFiles = new Set(readdirSync(join(webDir, 'tests')).filter((file) => file.endsWith('.e2e.ts')));

const mobileSource = readFileSync(join(mobileDir, 'src', 'examples.ts'), 'utf8');
const scenariosSource = readFileSync(join(mobileDir, 'tests-agent', 'scenarios.e2e.ts'), 'utf8');

const problems = [
  ...webProblems({ slugs: webSlugs(webSource), testFiles }),
  ...mobileProblems({ names: mobileNames(mobileSource), scenariosSource, withoutAgent: MOBILE_WITHOUT_AGENT }),
];

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`benchmark coverage: ${webSlugs(webSource).length} web scenarios and ${mobileNames(mobileSource).length} mobile scenarios have their tests\n`);
}
