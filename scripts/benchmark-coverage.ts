/**
 * The pairing rules the benchmark READMEs promise, as functions a test can
 * call: every web scenario has a deterministic twin, and every mobile scenario
 * has an agentic entry. The runner (`check-benchmark-coverage.ts`) reads the
 * catalogs and suites and reports the gaps; this module holds the parsing and
 * the comparison so the rules are covered beside the other check helpers.
 */

/** The scenario slugs a web catalog source declares, in file order. */
export function webSlugs(source: string): string[] {
  return [...source.matchAll(/slug:\s*"([^"]+)"/g)].map((match) => match[1]!);
}

/** The scenario names a mobile catalog source declares, in file order: every quoted `name:` property, whatever else the entry orders around it. */
export function mobileNames(source: string): string[] {
  return [...source.matchAll(/\bname:\s*(['"])(.*?)\1/g)].map((match) => match[2]!);
}

/** One web pairing rule: the catalog's slugs and the deterministic suite's files. */
export interface WebCoverage {
  readonly slugs: readonly string[];
  readonly testFiles: ReadonlySet<string>;
}

/**
 * The web benchmark's gaps: a catalog slug with no `tests/<slug>.e2e.ts`.
 * The agentic suite is intentionally partial (no web agentic check), only
 * the deterministic twin the README promises every scenario.
 */
export function webProblems(coverage: WebCoverage): string[] {
  const problems: string[] = [];
  for (const slug of coverage.slugs) {
    if (!coverage.testFiles.has(`${slug}.e2e.ts`)) {
      problems.push(`web: ${slug} has no tests/${slug}.e2e.ts; the README promises every scenario a deterministic twin`);
    }
  }
  return problems;
}

/** One mobile pairing rule: the catalog's names, the agentic suite's source, and the names allowed to have no agentic entry. */
export interface MobileCoverage {
  readonly names: readonly string[];
  readonly scenariosSource: string;
  readonly withoutAgent: readonly string[];
}

/**
 * The mobile benchmark's gaps: a catalog name with no entry in
 * `tests-agent/scenarios.e2e.ts`, outside the names allowed to have none.
 */
export function mobileProblems(coverage: MobileCoverage): string[] {
  const excluded = new Set(coverage.withoutAgent);
  return coverage.names
    .filter((name) => !excluded.has(name) && !declaresName(coverage.scenariosSource, name))
    .map((name) => `mobile: ${name} has no entry in tests-agent/scenarios.e2e.ts; the README promises one agent.act per scenario`);
}

/** Whether `source` declares a `name` property for `name`, in either quote style, so formatting alone never hides an entry. */
function declaresName(source: string, name: string): boolean {
  return source.includes(`name: '${name}'`) || source.includes(`name: "${name}"`);
}
