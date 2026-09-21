import { describe, expect, it } from 'vitest';
import { cliSessionEvent, EVENT_CLI_SESSION, EVENT_RUN_COMPLETED, runCompletedEvent } from '../../src/telemetry/events.ts';
import { SAMPLE_REPORT_SECRETS, sampleReport } from '../helpers/sample-report.ts';

describe('telemetry events', () => {
  it('the session event carries the command and the flag names only', () => {
    expect(cliSessionEvent('cache ls', ['--config'])).toEqual({
      name: EVENT_CLI_SESSION,
      properties: { command: 'cache ls', flags: ['--config'] },
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
      agent_steps_vision: 1,
      model_gateway: 'anthropic',
      model_provider: 'anthropic',
      model_id: 'claude-sonnet-4-5',
      model_calls: 4,
      model_tokens: 2850,
      model_cached_tokens: null,
      estimated_cost_usd: 0.01,
      artifact_bytes: 4096,
      errors: 1,
      error_codes: ['APP_UNREACHABLE', 'LOCATOR_NOT_FOUND', 'OTHER'],
    });
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
