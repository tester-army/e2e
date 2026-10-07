import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import type { McpSessionSummary } from '../../src/mcp/usage.ts';
import type { ReportExplore } from '../../src/report/build.ts';
import {
  cliSessionEvent,
  EVENT_CLI_SESSION,
  EVENT_INIT_COMPLETED,
  EVENT_MCP_SESSION,
  EVENT_RUN_COMPLETED,
  initCompletedEvent,
  mcpSessionEvent,
  runCompletedEvent,
  type RunContext,
} from '../../src/telemetry/events.ts';
import type { StepEvent } from '../../src/run/steps.ts';
import { REPORT_AT, reportAttempt, reportDocument, reportError, reportResult, reportStep } from '../helpers/report.ts';
import { SAMPLE_REPORT_SECRETS, sampleReport } from '../helpers/sample-report.ts';
import { snapshot } from '../helpers/snapshot.ts';

/** A structurally valid AI SDK model that is never called. */
function fakeModel(provider: string, modelId: string): unknown {
  return { specificationVersion: 'v4', provider, modelId, supportedUrls: {}, doGenerate: () => Promise.reject(new Error('not called')), doStream: () => Promise.reject(new Error('not called')) };
}

/** A run whose config never loaded, without flags. */
const RUN: RunContext = { command: 'run', flags: [], config: undefined };

/** One engine event of an agent step, as the dispatcher records an action. */
function engineEvent(name: string): StepEvent {
  return { kind: 'engine', startedAt: REPORT_AT, durationMs: 5, status: 'passed', name };
}

/** A document whose one result has the given attempts. */
function reportWithAttempts(...attempts: Parameters<typeof reportAttempt>[0][]) {
  return reportDocument({ results: [reportResult({ attempts: attempts.map((attempt) => reportAttempt(attempt)) })] });
}

describe('telemetry events', () => {
  it('the session event carries the command and the flag names only, and how it ended once known', () => {
    expect(cliSessionEvent('cache ls', ['--config'])).toEqual({
      name: EVENT_CLI_SESSION,
      properties: { command: 'cache ls', flags: ['--config'] },
    });
    expect(cliSessionEvent('run', [], { exitCode: 2, errorCode: 'CONFIG_NOT_FOUND', elapsedMs: 41.6 }).properties).toEqual({
      command: 'run',
      flags: [],
      exit_code: 2,
      error_code: 'CONFIG_NOT_FOUND',
      duration_ms: 42,
    });
    expect(cliSessionEvent('run', [], { exitCode: 0, errorCode: undefined, elapsedMs: -5 }).properties).toMatchObject({
      error_code: null,
      duration_ms: 0,
    });
  });

  it('the init event carries the result and the option ids chosen', () => {
    expect(
      initCompletedEvent({
        result: 'scaffolded',
        yes: false,
        existingConfig: false,
        engine: 'playwright',
        gateway: 'openai-compatible',
        skill: true,
        mcp: false,
        install: true,
      }),
    ).toEqual({
      name: EVENT_INIT_COMPLETED,
      properties: {
        result: 'scaffolded',
        yes: false,
        existing_config: false,
        engine: 'playwright',
        gateway: 'openai-compatible',
        skill: true,
        mcp: false,
        install: true,
      },
    });
  });

  it("the run event is the report's numbers, with project vocabulary folded", () => {
    const event = runCompletedEvent(sampleReport(), { ...RUN, flags: ['--headed', '--workers'] });
    expect(event.name).toBe(EVENT_RUN_COMPLETED);
    expect(event.at).toBe('2026-09-08T10:00:05.000Z');
    expect(event.properties).toEqual({
      command: 'run',
      status: 'failed',
      exit_code: 1,
      duration_ms: 5000,
      flags: ['--headed', '--workers'],
      tests_discovered: 3,
      tests_selected: 2,
      tests_executed: 2,
      tests_passed: 1,
      tests_failed: 1,
      tests_interrupted: 0,
      tests_flaky: 0,
      tests_skipped: 0,
      attempts_total: 2,
      tests_retried: 0,
      targets: 2,
      platforms: ['vision-pro', 'web'],
      engines: ['homegrown@9.9.9', 'playwright@0.6.1'],
      steps_total: 5,
      steps_agent: 2,
      steps_locator: 1,
      steps_assertion: 1,
      steps_screen: 1,
      steps_app: 0,
      steps_session: 0,
      steps_resource: 0,
      agent_steps_replayed: 1,
      agent_steps_partial: 0,
      agent_steps_missed: 1,
      agent_steps_relocated: 0,
      agent_steps_vision: 1,
      agent_actions: {},
      model_gateway: 'anthropic',
      model_provider: 'anthropic',
      model_id: 'claude-sonnet-4-5',
      model_calls: 4,
      model_tokens: 2850,
      model_cached_tokens: null,
      estimated_cost_usd: 0.01,
      cost_source: 'provider',
      artifact_bytes: 4096,
      errors: 1,
      primary_error_code: 'APP_UNREACHABLE',
      error_codes: ['APP_UNREACHABLE', 'LOCATOR_NOT_FOUND', 'OTHER'],
      error_kinds: [],
    });
  });

  it('names the first error recorded as the one that decided the status: the run, then the attempt, then a step', () => {
    const stepError = reportError({ code: 'LOCATOR_NOT_FOUND' });
    const attempt = { status: 'failed' as const, steps: [reportStep({ status: 'failed', error: stepError })] };
    const code = (report: ReturnType<typeof reportDocument>) => runCompletedEvent(report, RUN).properties['primary_error_code'];
    expect(code(reportWithAttempts({ ...attempt, error: reportError({ code: 'TEST_TIMEOUT' }) }))).toBe('TEST_TIMEOUT');
    expect(code(reportWithAttempts(attempt))).toBe('LOCATOR_NOT_FOUND');
    expect(code(reportWithAttempts({ secondaryErrors: [reportError({ code: 'CLEANUP_TIMEOUT' })] }))).toBe('CLEANUP_TIMEOUT');
    expect(code(reportWithAttempts({}))).toBeNull();
    const runLevel = reportDocument({ errors: [reportError({ code: 'APP_UNREACHABLE' })], results: [reportResult(attempt)] });
    expect(code(runLevel)).toBe('APP_UNREACHABLE');
  });

  it('files an engine, provider, or plain failure under a kind read off its message, never the message itself', () => {
    const report = reportWithAttempts({
      status: 'failed',
      secondaryErrors: [
        reportError({ code: 'ENGINE_FAILURE', message: 'launch failed: xcrun simctl boot 7F3A: unable to boot device in current state' }),
        reportError({ code: 'ENGINE_FAILURE', message: 'browser launch failed: Chromium revision at /home/acme is not found' }),
        reportError({ code: 'ENGINE_FAILURE', message: 'observe failed: navigation timed out after 30000 ms' }),
        reportError({ code: 'MODEL_PROVIDER_FAILED', message: 'model provider failed: 429 Too Many Requests' }),
        reportError({ code: 'MODEL_PROVIDER_FAILED', message: 'model provider failed: 503 Service Unavailable' }),
        reportError({ code: 'MODEL_PROVIDER_FAILED', message: 'model provider failed: Unauthorized; check the API key' }),
        reportError({ code: 'MODEL_PROVIDER_FAILED', message: 'model provider failed: fetch failed: connect ECONNREFUSED 127.0.0.1:11434' }),
        reportError({ code: 'ERROR', message: 'Cannot read properties of undefined (reading acme)' }),
        reportError({ code: 'WORKER_CRASH', message: 'worker process exited during this test' }),
        reportError({ code: 'ASSERTION_FAILED', message: 'expected acme timed out' }),
      ],
    });
    const event = runCompletedEvent(report, RUN);
    expect(event.properties['error_kinds']).toEqual([
      'ENGINE_FAILURE:browser',
      'ENGINE_FAILURE:device',
      'ENGINE_FAILURE:timeout',
      'ERROR:other',
      'MODEL_PROVIDER_FAILED:auth',
      'MODEL_PROVIDER_FAILED:network',
      'MODEL_PROVIDER_FAILED:overloaded',
      'MODEL_PROVIDER_FAILED:rate-limit',
    ]);
    const payload = JSON.stringify(event);
    for (const text of ['xcrun', '7F3A', '/home', 'Chromium', '11434', 'reading', '30000']) expect(payload).not.toContain(text);
  });

  it("counts the agent's actions by the runner's names, a project's tools together, and nothing on other steps", () => {
    const report = reportWithAttempts({
      steps: [
        reportStep({ kind: 'agent', api: 'agent.act', events: [engineEvent('tap'), engineEvent('typeText'), engineEvent('tap'), { ...engineEvent('turn'), kind: 'model' }] }),
        reportStep({ kind: 'agent', api: 'agent.act', events: [engineEvent('tool:acme_lookup'), engineEvent('tool:acme_reset'), engineEvent('scroll'), engineEvent('screenshot')] }),
        reportStep({ events: [engineEvent('tap')] }),
      ],
    });
    expect(runCompletedEvent(report, RUN).properties['agent_actions']).toEqual({ other: 1, scroll: 1, tap: 2, tool: 2, typeText: 1 });
    expect(JSON.stringify(runCompletedEvent(report, RUN))).not.toContain('acme');
  });

  it('counts the units that needed more than one attempt', () => {
    expect(runCompletedEvent(reportWithAttempts({ status: 'failed' }, { index: 1 }), RUN).properties['tests_retried']).toBe(1);
  });

  it('says whether the provider priced the calls', () => {
    expect(runCompletedEvent(reportWithAttempts({}), RUN).properties['cost_source']).toBeNull();
    const { estimatedCostUsd: _priced, ...model } = sampleReport().run.results[0]!.attempts[0]!.steps[0]!.model!;
    const unpriced = reportWithAttempts({ steps: [reportStep({ kind: 'agent', api: 'agent.act', model })] });
    expect(runCompletedEvent(unpriced, RUN).properties['cost_source']).toBe('none');
  });

  it('reports a missing duration as null rather than a negative or NaN number', () => {
    const report = sampleReport();
    (report.run as { finishedAt: string }).finishedAt = 'not a date';
    expect(runCompletedEvent(report, RUN).properties['duration_ms']).toBeNull();
  });

  it('folds an engine name or platform that is not a plain token into other', () => {
    const report = sampleReport();
    const homegrown = report.run.targets[1]!;
    (homegrown as { platform: string }).platform = 'Vision Pro (beta)';
    (homegrown as { engine: { name: string } }).engine.name = 'acme/engine';
    const { properties } = runCompletedEvent(report, RUN);
    expect(properties['platforms']).toEqual(['other', 'web']);
    expect(properties['engines']).toEqual(['other', 'playwright@0.6.1']);
  });

  it('reports the gateway, the vendor, and the id of a gateway-served model', () => {
    const report = sampleReport();
    const [first] = report.run.results[0]!.attempts[0]!.steps;
    (first as { model: { provider: string; model: string } }).model.provider = 'openrouter';
    (first as { model: { provider: string; model: string } }).model.model = 'openai/gpt-5.4-mini';
    const { properties } = runCompletedEvent(report, RUN);
    expect(properties['model_gateway']).toBe('openrouter');
    expect(properties['model_provider']).toBe('openai');
    expect(properties['model_id']).toBe('gpt-5.4-mini');
  });

  it('folds a fine-tuned or routed model id into other', () => {
    const report = sampleReport();
    const [first] = report.run.results[0]!.attempts[0]!.steps;
    (first as { model: { model: string } }).model.model = 'accounts/acme/models/custom';
    expect(runCompletedEvent(report, RUN).properties['model_id']).toBe('other');
  });

  it('copies no title, file, origin, or message out of the report', () => {
    const payload = JSON.stringify(runCompletedEvent(sampleReport(), { ...RUN, flags: ['--headed'] }));
    for (const secret of SAMPLE_REPORT_SECRETS) expect(payload).not.toContain(secret);
  });

  it('reports which config features a run used by count and option id, never a name the project chose', () => {
    const engine = defineEngine({ name: 'acme-engine', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]) });
    const config = resolveConfig(
      {
        targets: [
          { name: 'acme-web', platform: 'web', engine, app: { url: 'https://acme.example/', command: { executable: 'node', args: ['acme-server.mjs'] } } },
          { name: 'acme-staging', platform: 'web', engine, app: { url: 'https://staging.acme.example/', environment: 'staging' }, video: 'retain-on-failure' },
        ],
        workers: 3,
        retries: 1,
        credentials: { acmeAdmin: { username: 'admin@acme.example', password: 'acme-pw' } },
        secrets: { acmeToken: 'acme-token-value' },
        reporters: ['list', 'junit'],
      },
      { projectRoot: '/tmp/acme', env: {} },
    );
    const event = runCompletedEvent(sampleReport(), { ...RUN, config });
    expect(event.properties).toMatchObject({
      config_workers: 3,
      config_retries: 1,
      config_agents: 1,
      config_custom_executor: false,
      config_separate_judge: false,
      config_project_tools: 0,
      config_credentials: 1,
      config_secrets: 1,
      config_cache_mode: 'read-write',
      config_cache_store: 'file',
      config_cache_strict: false,
      config_reporters: ['junit', 'list'],
      config_custom_reporters: 0,
      config_artifact_store: false,
      config_trace_modes: ['on'],
      config_video_modes: ['off', 'retain-on-failure'],
      config_app_commands: 1,
      config_environments: ['production', 'staging'],
    });
    expect(JSON.stringify(event)).not.toMatch(/acme|admin@|token-value|pw/u);
    expect(runCompletedEvent(sampleReport(), RUN).properties).not.toHaveProperty('config_workers');
  });

  it('counts a judge as separate only when it is another model, not another instance of the same one', () => {
    const separate = (agent: Record<string, unknown>) =>
      runCompletedEvent(sampleReport(), { ...RUN, config: resolveConfig({ targets: [{ platform: 'web' }], agents: { default: agent } } as never, { projectRoot: '/tmp/acme', env: {} }) })
        .properties['config_separate_judge'];
    expect(separate({ model: fakeModel('openai', 'gpt-5'), judge: fakeModel('openai', 'gpt-5') })).toBe(false);
    expect(separate({ model: fakeModel('openai', 'gpt-5-mini'), judge: fakeModel('openai', 'gpt-5') })).toBe(true);
  });

  it('counts what an exploration was given and found, never its goal, charters, or findings', () => {
    const explore: ReportExplore = {
      goal: 'Explore the acme checkout',
      budgets: { maxSteps: 8, timeoutMs: 600_000 },
      ended: 'step-limit',
      summary: 'The acme checkout loses the cart',
      steps: [
        { index: 1, title: 'Acme cart', instruction: 'Add an acme item', status: 'passed', startedAt: REPORT_AT, durationMs: 10 },
        { index: 2, title: 'Acme pay', instruction: 'Pay', status: 'exhausted', errorCode: 'AGENT_BUDGET', startedAt: REPORT_AT, durationMs: 10 },
      ],
      findings: [
        { id: 'f1', index: 1, step: 2, kind: 'issue', severity: 5, title: 'Acme cart empties', expected: 'kept', actual: 'lost', reproduction: ['acme'], reportedAt: REPORT_AT },
        { id: 'f2', index: 2, kind: 'warning', severity: 2, title: 'Acme label', expected: 'a', actual: 'b', reproduction: [], path: '/acme/pay', reportedAt: REPORT_AT },
      ],
    };
    const report = sampleReport();
    (report.run as { explore?: ReportExplore }).explore = explore;
    const event = runCompletedEvent(report, { ...RUN, command: 'explore' });
    expect(event.properties).toMatchObject({
      command: 'explore',
      explore_ended: 'step-limit',
      explore_max_steps: 8,
      explore_timeout_ms: 600_000,
      explore_steps: 2,
      explore_steps_passed: 1,
      explore_steps_failed: 0,
      explore_steps_blocked: 0,
      explore_steps_exhausted: 1,
      explore_assessed: true,
      explore_issues: 1,
      explore_warnings: 1,
      explore_findings_by_severity: { '1': 0, '2': 1, '3': 0, '4': 0, '5': 1 },
    });
    expect(JSON.stringify(event)).not.toMatch(/acme|Pay|kept|lost/iu);
    expect(runCompletedEvent(sampleReport(), RUN).properties).not.toHaveProperty('explore_ended');
  });
});

describe('the MCP session event', () => {
  const summary = (overrides: Partial<McpSessionSummary> = {}): McpSessionSummary => ({
    outcome: 'closed',
    endedBy: 'agent',
    openErrorCode: undefined,
    platform: 'web',
    engine: { name: 'web', version: '0.11.1' },
    headed: true,
    durationMs: 1234.4,
    concurrent: 1,
    toolCalls: new Map([['tap', 3], ['observe', 2], ['acme_reset', 1]]),
    projectToolCalls: 2,
    failedCalls: 2,
    errorCodes: new Map([['LOCATOR_NOT_FOUND', 1], ['acme.failure', 1]]),
    ...overrides,
  });

  it('carries the client, the target, how it ended, and the calls by the runner\'s tool names', () => {
    expect(mcpSessionEvent(summary(), { name: 'claude-code', version: '2.1.0' })).toEqual({
      name: EVENT_MCP_SESSION,
      properties: {
        client: 'claude-code',
        client_version: '2.1.0',
        outcome: 'closed',
        ended_by: 'agent',
        error_code: null,
        platform: 'web',
        engine: 'web@0.11.1',
        headed: true,
        duration_ms: 1234,
        sessions_open: 1,
        calls_total: 8,
        calls_failed: 2,
        calls: { observe: 2, other: 1, tap: 3, tool: 2 },
        error_codes: { LOCATOR_NOT_FOUND: 1, OTHER: 1 },
      },
    });
  });

  it('folds a client named like a path or a sentence, and reports a failed open by its code', () => {
    const event = mcpSessionEvent(
      summary({ outcome: 'open-failed', endedBy: undefined, openErrorCode: 'APP_UNREACHABLE', platform: undefined, engine: undefined, toolCalls: new Map(), projectToolCalls: 0, failedCalls: 0, errorCodes: new Map() }),
      { name: 'Acme Internal Agent (/home/acme)', version: 'https://acme.example' },
    );
    expect(event.properties).toMatchObject({
      client: 'other',
      client_version: 'other',
      outcome: 'open-failed',
      ended_by: null,
      error_code: 'APP_UNREACHABLE',
      platform: null,
      engine: null,
      calls_total: 0,
      calls: {},
    });
    expect(JSON.stringify(event)).not.toContain('acme');
    expect(mcpSessionEvent(summary(), undefined).properties).toMatchObject({ client: null, client_version: null });
  });
});
