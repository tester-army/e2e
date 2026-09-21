import { describe, expect, it } from 'vitest';
import {
  cliSessionEvent,
  EVENT_CLI_SESSION,
  EVENT_INIT_COMPLETED,
  EVENT_RUN_COMPLETED,
  initCompletedEvent,
  runCompletedEvent,
} from '../../src/telemetry/events.ts';
import type { StepEvent } from '../../src/run/steps.ts';
import { REPORT_AT, reportAttempt, reportDocument, reportError, reportResult, reportStep } from '../helpers/report.ts';
import { SAMPLE_REPORT_SECRETS, sampleReport } from '../helpers/sample-report.ts';

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
    const event = runCompletedEvent(sampleReport(), ['--headed', '--workers']);
    expect(event.name).toBe(EVENT_RUN_COMPLETED);
    expect(event.at).toBe('2026-09-08T10:00:05.000Z');
    expect(event.properties).toEqual({
      status: 'failed',
      exit_code: 1,
      duration_ms: 5000,
      flags: ['--headed', '--workers'],
      tests_discovered: 3,
      tests_selected: 2,
      tests_executed: 2,
      tests_passed: 1,
      tests_failed: 1,
      tests_flaky: 0,
      tests_skipped: 1,
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
      steps_test: 0,
      agent_steps_replayed: 1,
      agent_steps_partial: 0,
      agent_steps_missed: 1,
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
    const code = (report: ReturnType<typeof reportDocument>) => runCompletedEvent(report, []).properties['primary_error_code'];
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
    const event = runCompletedEvent(report, []);
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
    expect(runCompletedEvent(report, []).properties['agent_actions']).toEqual({ other: 1, scroll: 1, tap: 2, tool: 2, typeText: 1 });
    expect(JSON.stringify(runCompletedEvent(report, []))).not.toContain('acme');
  });

  it('counts attempts across tests and serial groups, and the units that needed more than one', () => {
    const report = reportWithAttempts({ status: 'failed' }, { index: 1 });
    const { properties } = runCompletedEvent(report, []);
    expect(properties['attempts_total']).toBe(2);
    expect(properties['tests_retried']).toBe(1);
    expect(runCompletedEvent(sampleReport(), []).properties['attempts_total']).toBe(2);
  });

  it('says whether the provider priced the calls', () => {
    const priced = reportWithAttempts({});
    expect(runCompletedEvent(priced, []).properties['cost_source']).toBeNull();
    const { estimatedCostUsd: _priced, ...model } = sampleReport().run.results[0]!.attempts[0]!.steps[0]!.model!;
    const unpriced = reportWithAttempts({ steps: [reportStep({ kind: 'agent', api: 'agent.act', model })] });
    expect(runCompletedEvent(unpriced, []).properties['cost_source']).toBe('none');
    expect(runCompletedEvent(sampleReport(), []).properties['cost_source']).toBe('provider');
  });

  it('folds an engine name or platform that is not a plain token into other', () => {
    const report = sampleReport();
    const homegrown = report.run.targets[1]!;
    (homegrown as { platform: string }).platform = 'Vision Pro (beta)';
    (homegrown as { engine: { name: string } }).engine.name = 'acme/engine';
    const { properties } = runCompletedEvent(report, []);
    expect(properties['platforms']).toEqual(['other', 'web']);
    expect(properties['engines']).toEqual(['other', 'playwright@0.6.1']);
  });

  it('reports the gateway, the vendor, and the id of a gateway-served model', () => {
    const report = sampleReport();
    const [first] = report.run.results[0]!.attempts[0]!.steps;
    (first as { model: { provider: string; model: string } }).model.provider = 'openrouter';
    (first as { model: { provider: string; model: string } }).model.model = 'openai/gpt-5.4-mini';
    const { properties } = runCompletedEvent(report, []);
    expect(properties['model_gateway']).toBe('openrouter');
    expect(properties['model_provider']).toBe('openai');
    expect(properties['model_id']).toBe('gpt-5.4-mini');
  });

  it('folds a fine-tuned or routed model id into other', () => {
    const report = sampleReport();
    const [first] = report.run.results[0]!.attempts[0]!.steps;
    (first as { model: { model: string } }).model.model = 'accounts/acme/models/custom';
    expect(runCompletedEvent(report, []).properties['model_id']).toBe('other');
  });

  it('copies no title, file, origin, or message out of the report', () => {
    const payload = JSON.stringify(runCompletedEvent(sampleReport(), ['--headed']));
    for (const secret of SAMPLE_REPORT_SECRETS) expect(payload).not.toContain(secret);
  });

  it('reports a missing duration as null rather than a negative or NaN number', () => {
    const report = sampleReport();
    (report.run as { finishedAt: string }).finishedAt = 'not a date';
    expect(runCompletedEvent(report, []).properties['duration_ms']).toBeNull();
  });
});
