/**
 * Shared vocabulary of the App Store readiness suite. A check is one
 * `judge` call: screenshot the screen, ask the model for a verdict against
 * the rubric in its context, and hand the finding to `conclude`, which
 * appends it to `.e2e/appstore/findings.jsonl` and fails the test only for
 * a rejection-level violation. `scripts/appstore-report.mjs` renders the file.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Agent, App, VisionMode } from '@e2edev/e2e';
import type { Device } from '@e2edev/agent-device';

export { test } from '@e2edev/agent-device';

const TESTBED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FINDINGS_FILE = resolve(TESTBED_ROOT, '.e2e', 'appstore', 'findings.jsonl');

/** The rubric (`context/guidelines.md`) as test options; `extract` reads the test's `agentContext`. */
export const RUBRIC = {
  agentContext: readFileSync(resolve(TESTBED_ROOT, 'tests-appstore', 'context', 'guidelines.md'), 'utf8'),
} as const;

/** `rejection` fails the test; `advisory` only shows in the report. */
export interface Guideline {
  readonly id: string;
  readonly title: string;
  readonly severity: 'rejection' | 'advisory';
  readonly url: string;
}

const define = (id: string, title: string, severity: Guideline['severity'], anchor: string): Guideline => ({
  id,
  title,
  severity,
  url: `https://developer.apple.com/app-store/review/guidelines/#${anchor}`,
});

export const GUIDELINES = {
  completeness: define('2.1', 'App Completeness', 'rejection', 'app-completeness'),
  payments: define('3.1.1', 'In-App Purchase', 'rejection', 'in-app-purchase'),
  subscriptions: define('3.1.2', 'Subscriptions', 'rejection', 'subscriptions'),
  ugc: define('1.2', 'User-Generated Content', 'rejection', 'user-generated-content'),
  minimumFunctionality: define('4.2', 'Minimum Functionality', 'advisory', 'minimum-functionality'),
  design: define('4.0', 'Design (Human Interface Guidelines)', 'advisory', 'design'),
  loginServices: define('4.8', 'Login Services', 'rejection', 'login-services'),
  privacyPolicy: define('5.1.1(i)', 'Privacy Policies', 'rejection', 'data-collection-and-storage'),
  permissionPurpose: define('5.1.1(ii)', 'Permission purpose strings', 'rejection', 'data-collection-and-storage'),
  permissionAccess: define('5.1.1(iv)', 'Works without unnecessary permissions', 'rejection', 'data-collection-and-storage'),
  accountDeletion: define('5.1.1(v)', 'Account deletion', 'rejection', 'data-collection-and-storage'),
  loginGate: define('5.1.1(v)', 'Use without an account', 'advisory', 'data-collection-and-storage'),
} as const;

const VERDICT = z.object({
  verdict: z
    .enum(['compliant', 'violation', 'not-applicable', 'unverified'])
    .describe(
      'compliant: the guideline is met; violation: it is not; not-applicable: the app has no feature this guideline governs; unverified: the evidence could not be reached from here',
    ),
  summary: z.string().describe('one sentence a developer can act on'),
  evidence: z.array(z.string()).describe('exact on-screen copy or element names that support the verdict; empty when none'),
});

type Verdict = z.infer<typeof VERDICT>['verdict'];

export interface Finding extends z.infer<typeof VERDICT> {
  readonly guideline: Guideline;
  readonly check: string;
  readonly screenshots: readonly string[];
  readonly app: string;
}

export interface Fixtures {
  readonly agent: Agent;
  readonly app: App;
  readonly device: Device;
}

/** Screenshots the current screen and asks the model for a verdict on one check. */
export async function judge(
  { agent, app, device }: Fixtures,
  guideline: Guideline,
  check: string,
  question: string,
  options: { vision?: VisionMode } = {},
): Promise<Finding> {
  const screenshot = await app.screenshot(slug(check));
  const result = await agent.extract(
    `Judge App Store guideline ${guideline.id} (${guideline.title}) from this screen: ${question}`,
    { schema: VERDICT, ...(options.vision === undefined ? {} : { vision: options.vision }) },
  );
  const foreground = await device.foregroundApp();
  return { guideline, check, ...result, screenshots: [screenshot], app: foreground.bundleId ?? foreground.name };
}

const RANK: Record<Verdict, number> = { violation: 0, unverified: 1, compliant: 2, 'not-applicable': 3 };

/** Folds per-screen findings for one check into one, keeping the worst verdict. */
export function merge(findings: readonly Finding[], check: string, cleanSummary: string): Finding {
  const worst = findings.toSorted((a, b) => RANK[a.verdict] - RANK[b.verdict])[0];
  if (worst === undefined) throw new Error(`merge: no findings for ${check}`);
  const flagged = findings.filter((finding) => finding.verdict === 'violation');
  return {
    ...worst,
    check,
    summary: flagged.length === 0 ? cleanSummary : flagged.map((finding) => finding.summary).join(' '),
    evidence: findings.flatMap((finding) => finding.evidence),
    screenshots: findings.flatMap((finding) => finding.screenshots),
  };
}

/** Records every finding, then fails the test on the first rejection-level violation. */
export function conclude(...findings: readonly Finding[]): void {
  mkdirSync(dirname(FINDINGS_FILE), { recursive: true });
  for (const finding of findings) {
    appendFileSync(FINDINGS_FILE, `${JSON.stringify({ ...finding, recordedAt: new Date().toISOString() })}\n`);
  }
  const rejection = findings.find((f) => f.verdict === 'violation' && f.guideline.severity === 'rejection');
  if (rejection === undefined) return;
  throw new Error(
    [
      `App Store guideline ${rejection.guideline.id} (${rejection.guideline.title}): ${rejection.summary}`,
      ...rejection.evidence.map((line) => `  - ${line}`),
      `  see ${rejection.guideline.url}`,
    ].join('\n'),
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'screen';
}
