/**
 * The runner's two kinds of standalone worker. A hosted attempt is a test in
 * another runner (`openHost` on `e2e/runner`): it publishes itself for
 * `expect.soft` and `expect.poll`, holds the live secret registry, and writes
 * a trace under `results/host/`. A one-shot attempt is `e2e mcp`'s live
 * session, with artifacts under `results/mcp/`, which may run one collected
 * test (`open_session {test}`).
 */

import { createAgentCacheContext } from '../cache/context.ts';
import { storedRecordingsFor } from '../cache/rekeyed.ts';
import { publishAttempt } from '../expect/attempt.ts';
import { SoftFailures } from '../expect/soft.ts';
import type { SerializedError } from '../internal/errors.ts';
import { resultId } from '../internal/ids.ts';
import { Deadline } from '../internal/time.ts';
import { holdSecretRegistry } from '../secrets.ts';
import type { Report } from '../run-types.ts';
import { resultSegment } from './artifacts.ts';
import { AttemptBudget } from './budget.ts';
import { TargetExecutor } from './execute.ts';
import { createFixtures } from './fixtures.ts';
import { writeHostTrace } from './host-trace.ts';
import { WrittenScreenshots } from './screenshots.ts';
import { processSecrets } from './secrecy.ts';
import { targetIdentity } from './sessions.ts';
import { openWorker, type StandaloneHost, type StandaloneHostOptions, type WorkerPolicy } from './standalone.ts';
import type { StandaloneAttempt, StandaloneSessionOptions } from './standalone-attempt.ts';
import { createStandaloneTestRun, type StandaloneTest, type StandaloneTestRun } from './standalone-test.ts';

/** What a hosted attempt keeps beside the shared ones: the report its trace was written from. */
export interface HostedReport {
  report: Report | undefined;
}

/** The runner's sessions on a standalone worker: a `TargetExecutor` that runs no units. */
const runnerSessions: WorkerPolicy<TargetExecutor, never>['sessions'] = (options) => new TargetExecutor({ ...options, isolated: false });

/** Prepares, starts app processes, and initializes one worker for a hosted test runner. */
export function openStandaloneHost(options: StandaloneHostOptions): Promise<StandaloneHost<HostedReport>> {
  return openWorker<TargetExecutor, HostedReport>(options, {
    claimsEngine: true,
    sessions: runnerSessions,
    identity: ({ target, config }, attemptId, agent, redactedName) => {
      // The directory is `host/<file>-<title>-<digest>`: the digest covers the
      // unique attempt id, so repeated names never share a directory, and the
      // title slug is dropped while a provider's values are unknown, since no
      // caller text can then be vouched for as a path.
      const testId = `host:${attemptId}`;
      const providerSecrets = [...config.allSecrets.values()].some((secret) => typeof secret.value === 'function');
      const title = providerSecrets ? 'session' : processSecrets.redact(redactedName);
      const segment = resultSegment({ id: resultId(testId, target.name, agent, 0), file: 'host', titlePath: [title] });
      return { testId, segments: ['host', segment] };
    },
    reserve: ({ config }, { attemptId, budget, polls }) => {
      const soft = new SoftFailures();
      const publication = new AbortController();
      publishAttempt({ attemptId, owner: 'host', testKind: 'test', assertionTimeout: config.assertionTimeout, budget, soft, polls }, publication.signal);
      // The live attempt's secrets resolve against its own config while other hosts hold theirs.
      const releaseRegistry = holdSecretRegistry(config, { live: true });
      return { close: () => soft.close(), release: () => { publication.abort(); releaseRegistry(); } };
    },
    launched: () => ({ report: undefined }),
    closed: async ({ worker, extra, identity, agent, options: opened, tracePath, redact, record }) => {
      const { config, target, runId, resultsDir } = worker;
      extra.report = await writeHostTrace({
        config, target, runId, testId: identity.testId, agent, tracePath, redact,
        title: processSecrets.redact(redact(opened.name ?? target.name)),
        resultsDir, segments: identity.segments,
        attempt: { ...record, index: 0 },
      });
    },
  });
}

export interface StandaloneAttemptOptions extends StandaloneHostOptions, StandaloneSessionOptions {
  /**
   * The collected test the attempt runs (`open_session {test}`): the attempt
   * takes its identity, agent context, and replay cache, and exposes the run
   * as `test`.
   */
  readonly test?: StandaloneTest | undefined;
}

/** MCP's attempt, with the test it runs when its options named one. */
export interface OneShotAttempt extends StandaloneAttempt<StandaloneTestRun | undefined> {
  readonly test: StandaloneTestRun | undefined;
}

/**
 * MCP's one attempt on a worker of its own, closed together. MCP keeps its own
 * engine ownership. The teardown of a test the attempt ran drives the app, so
 * it runs before the host's close cancels the attempt's operations.
 */
export async function openStandaloneAttempt(options: StandaloneAttemptOptions): Promise<OneShotAttempt> {
  const { test } = options;
  const host = await openWorker<TargetExecutor, StandaloneTestRun | undefined>(options, {
    claimsEngine: false,
    sessions: runnerSessions,
    identity: ({ target }, attemptId) => ({ testId: test?.pair.test.id ?? `session:${target.name}`, segments: ['mcp', `${target.name}-${attemptId}`] }),
    launched: ({ worker, attemptId, session, steps, artifacts, fixtureBase, signal, redact }) => {
      if (test === undefined) return undefined;
      const { config, target, executor, runId } = worker;
      // The test's fixtures have a budget of their own, so a body its timeout
      // cut short cannot drive the session the agent uses afterwards. Its
      // agent steps replay and record as on a run's first attempt, and its
      // screenshots count as written by a run of their own: a baseline one
      // session wrote is compared against in the next, as the next run would.
      // Its agent steps read the test's title, as they do in a run.
      const testBudget = new AttemptBudget(signal, new Deadline(test.pair.options.timeout));
      const cache = createAgentCacheContext({
        cache: config.cache, projectRoot: config.projectRoot, projectId: config.projectId, testId: test.pair.test.id,
        target: targetIdentity(target), attemptIndex: 0, recordings: storedRecordingsFor(config.cache),
      });
      const { fixtures } = createFixtures({
        ...fixtureBase, attempt: { ...fixtureBase.attempt, titlePath: test.pair.test.titlePath }, budget: testBudget, agentContext: test.pair.options.agentContext,
        ...(cache === undefined ? {} : { cache }),
        test: { file: test.pair.test.file, titlePath: test.pair.test.titlePath, writtenScreenshots: new WrittenScreenshots(artifacts.dir) },
      });
      return createStandaloneTestRun({
        config, target, executor, runId, attemptId, session, steps, budget: testBudget, fixtures,
        artifacts: artifacts.sink, cache, signal, redact,
      }, test);
    },
  });
  try {
    const attempt = await host.openAttempt(options);
    const close = async (): Promise<readonly SerializedError[]> => {
      const torn = (await attempt.extra?.teardown()) ?? [];
      // A test's `beforeAll` failure is a run error too, and was its outcome when the session opened.
      const closed = (await host.close()).filter((error) => attempt.extra === undefined || error.phase !== 'beforeAll');
      return [...torn, ...closed];
    };
    return { ...attempt, test: attempt.extra, close };
  } catch (cause) {
    await host.close();
    throw cause;
  }
}
