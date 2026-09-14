/**
 * Shared vocabulary of the App Store readiness suite. A check is one
 * `judge` call: screenshot the screen, ask the model for a verdict against
 * the rubric in its context, and hand the finding to the test's `conclude`,
 * which appends it to `.e2e/appstore/findings.jsonl` under the test's title
 * and fails the test only for a rejection-level violation.
 * `scripts/appstore-report.mjs` renders the file, matching findings to
 * runner results by that title.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Agent, AgentErrorCode, App, Credential, VisionMode } from 'e2e';
import { credentials, isAgentError } from 'e2e';
import type { Device } from '@e2edev/agent-device';

import { test } from '@e2edev/agent-device';

const TESTBED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FINDINGS_FILE = resolve(TESTBED_ROOT, '.e2e', 'appstore', 'findings.jsonl');

/** The rubric (`context/guidelines.md`) as test options; `extract` reads the test's `agentContext`. */
const RUBRIC = {
  agentContext: readFileSync(resolve(TESTBED_ROOT, 'tests-appstore', 'context', 'guidelines.md'), 'utf8'),
} as const;

/** The account the reviewer signs in with, declared by the config when `E2E_USER_REVIEWER_PASSWORD` is set. */
const REVIEWER = 'reviewer';

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

/** Records findings under the enclosing test's title; throws on a rejection-level violation. */
export type Conclude = (...findings: readonly Finding[]) => void;

/**
 * One audit test. The title is what the report matches findings to, so the
 * `conclude` handed to the body stamps it on every finding it records; two
 * checks under one guideline stay distinguishable in the coverage table.
 */
export function audit(
  title: string,
  tags: readonly string[],
  body: (fx: Fixtures, conclude: Conclude) => Promise<void>,
): void {
  test(title, { ...RUBRIC, tags }, (fx) => body(fx, (...findings) => conclude(title, ...findings)));
}

/**
 * Signs in with the reviewer account when the config declares one and
 * reports whether it did. The app keeps the session on the simulator, so
 * one sign-in in the first check (`account.e2e.ts`, first by file order)
 * carries every later check past the wall. The password is a secret the
 * runner fills into the password field; the model never sees it, and the
 * attempt that filled it gets no screenshots, so a check signs in after
 * its judgments.
 */
export async function signIn({ agent }: Fixtures): Promise<boolean> {
  const reviewer = reviewerAccount();
  if (reviewer === undefined) return false;
  await agent.act(
    'sign in with the reviewer account: open Sign in if the form is not showing, enter the username, fill the password with the secret, submit, and dismiss any onboarding that follows until the app shows its content; if the app is already signed in, do nothing',
    { params: { username: reviewer.username, password: reviewer.password } },
  );
  return true;
}

function reviewerAccount(): Credential | undefined {
  try {
    return credentials.user(REVIEWER);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'AUTH_CREDENTIAL_UNAVAILABLE') return undefined;
    throw error;
  }
}

/**
 * Failures that are the runner's or the model's, never the app's: a step
 * that ends in one has no account of the screen worth judging.
 */
const HARD_STOPS: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  'MODEL_UNAVAILABLE',
  'MODEL_PROVIDER_FAILED',
  'MODEL_OUTPUT_INVALID',
  'CONTEXT_OVERFLOW',
  'ENVIRONMENT_UNAVAILABLE',
  'APP_UNREACHABLE',
  'APP_ALREADY_RUNNING',
  'AUTOMATION_UNSUPPORTED',
  'POLICY_DENIED',
  'TEST_SETUP_FAILED',
  'STEP_TIMEOUT',
  'CANCELLED',
]);

/**
 * Navigates toward the evidence a check needs. An agent that searched and
 * concluded the screen is not there, or that a sign-in wall it has no
 * account for is in the way, has done its job: the verdict belongs to the
 * judge, so the step's account comes back as a note for it instead of
 * failing the check. The runner's own failures still throw.
 */
export async function reach({ agent }: Fixtures, instruction: string): Promise<string | undefined> {
  try {
    await agent.act(instruction);
    return undefined;
  } catch (error) {
    if (!isAgentError(error) || HARD_STOPS.has(error.code)) throw error;
    return error.explanation;
  }
}

/**
 * Waits for a fresh launch to show its first real screen. A React Native
 * app answers its first observation with the splash, and a judgment or an
 * extract taken then reads an empty screen; the act loop re-observes on
 * its own and needs no such wait.
 */
export async function launched({ agent }: Fixtures): Promise<void> {
  await agent
    .waitFor('the app has finished launching: its main content or a sign-in screen is showing, not a splash or loading state', {
      timeout: 20_000,
    })
    .catch(() => undefined);
}

export interface JudgeOptions {
  readonly vision?: VisionMode;
  /** What the navigation step reported when it stopped short; see `reach`. */
  readonly note?: string | undefined;
}

/** Screenshots the current screen and asks the model for a verdict on one check. */
export async function judge(
  { agent, app, device }: Fixtures,
  guideline: Guideline,
  check: string,
  question: string,
  options: JudgeOptions = {},
): Promise<Finding> {
  // Denied after a secret fill in this attempt; a verdict without a picture
  // beats no verdict.
  const screenshot = await app.screenshot(slug(check)).catch(() => undefined);
  const result = await agent.extract(
    [
      `Judge App Store guideline ${guideline.id} (${guideline.title}) from this screen: ${question}`,
      ...(options.note === undefined ? [] : [`The reviewer who navigated here reported: ${options.note}`]),
    ].join('\n\n'),
    { schema: VERDICT, ...(options.vision === undefined ? {} : { vision: options.vision }) },
  );
  const foreground = await device.foregroundApp();
  return {
    guideline,
    check,
    ...result,
    screenshots: screenshot === undefined ? [] : [screenshot],
    app: foreground.bundleId ?? foreground.name,
  };
}

/** A finding that stands in for evidence the check could not collect. */
export async function unverified(
  { device }: Fixtures,
  guideline: Guideline,
  check: string,
  summary: string,
  screenshots: readonly string[] = [],
): Promise<Finding> {
  const foreground = await device.foregroundApp();
  return { guideline, check, verdict: 'unverified', summary, evidence: [], screenshots, app: foreground.bundleId ?? foreground.name };
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
    // An unverified worst finding keeps its own account: the clean summary
    // would claim a check that could not be read explains itself.
    summary:
      flagged.length > 0
        ? flagged.map((finding) => finding.summary).join(' ')
        : worst.verdict === 'unverified'
          ? worst.summary
          : cleanSummary,
    evidence: findings.flatMap((finding) => finding.evidence),
    screenshots: findings.flatMap((finding) => finding.screenshots),
  };
}

/** Records every finding under the test's title, then fails the test on the first rejection-level violation. */
function conclude(title: string, ...findings: readonly Finding[]): void {
  mkdirSync(dirname(FINDINGS_FILE), { recursive: true });
  for (const finding of findings) {
    appendFileSync(FINDINGS_FILE, `${JSON.stringify({ ...finding, test: title, recordedAt: new Date().toISOString() })}\n`);
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
