/**
 * `e2e doctor`: whether `e2e run` can start here, checked without starting
 * anything. It loads the config, asks each target's engine what it needs on
 * this machine, and names the model each agent resolved to. It never claims
 * which credential a model reads: the instance owns that. Only a login e2e
 * stores is checked, and `--check-model` makes one real call per model. A
 * model `--model` names needs no config entry and is checked even when the
 * config fails.
 */

import picocolors from 'picocolors';
import { createModelAdapter } from '../agent/model/sdk.ts';
import { ModelOutputInvalidError } from '../agent/model/adapter.ts';
import { loadAiSdk } from '../agent/ai-sdk.ts';
import { AgentError, isAgentError } from '../agent/error.ts';
import { engineAppInfo } from '../config/app.ts';
import { DEFAULT_LIMITS, modelLabel, type ResolvedAgentConfig, type ResolvedModel } from '../config/agent.ts';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import type { ResolvedTarget } from '../config/targets.ts';
import { selectTargets } from '../collect/select.ts';
import type { EngineDoctorCheck } from '../engine/index.ts';
import { classifyError, ConfigurationError, InfrastructureError } from '../internal/errors.ts';
import { onBun, SUPPORTED_BUN_RANGE, SUPPORTED_NODE_RANGE } from '../internal/runtime.ts';
import { budgetText, cancelledError, NEVER_ABORTS, withAbort, withinCleanupBudget } from '../internal/time.ts';
import { loginOf } from '../oauth/login-model.ts';
import { PROVIDER_IDS } from '../oauth/provider-ids.ts';
import { apiKeyFor, getProvider, isProviderId, loginHint, type ProviderId } from '../oauth/providers.ts';
import { defaultCredentialStore } from '../oauth/store.ts';
import { bounded } from '../report/format.ts';
import { processSecrets, registerStaticSecrets } from '../run/secrecy.ts';
import type { RunnerOutput } from '../run/process-output.ts';
import type { ModelInstance } from '../types.ts';

/** The `schemaVersion` of `e2e doctor --json`, described by `schema/doctor-v1.schema.json`. */
const DOCTOR_SCHEMA_VERSION = 'doctor-1';

/** How long one engine's `doctor` hook may take: it should only look things up. */
const ENGINE_DOCTOR_TIMEOUT_MS = 30_000;

/** How long a timed-out or cancelled engine `doctor` hook may take to settle: a protocol engine's 5 s grace and its connection's close fit in it. */
const ENGINE_DOCTOR_TEARDOWN_MS = 15_000;

/** How long one `--check-model` call may take, transport retries included. */
const MODEL_CALL_TIMEOUT_MS = 60_000;

/** Transport retries of a `--check-model` call: one rides out a blip, more would hide a refused connection behind the timeout. */
const MODEL_CALL_RETRIES = 1;

/** A check id: kebab case, as `EngineDoctorCheck.id` declares. */
const CHECK_ID = /^[a-z][a-z0-9-]*$/;

/** The ids of doctor's own checks, which an engine's finding cannot take. */
const RESERVED_IDS: ReadonlySet<string> = new Set(['node', 'config', 'engine', 'model']);

const ENGINE_STATUSES: ReadonlySet<string> = new Set<EngineDoctorCheck['status']>(['pass', 'warn', 'fail', 'skip']);

/** `pass`; `warn` for what a run handles on its own; `fail` for what stops a run; `skip` for a check that does not apply; `unknown` for what doctor cannot tell. */
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'unknown';

/** A model as the AI SDK instance names itself. */
interface DoctorModel {
  readonly provider: string;
  readonly modelId: string;
}

/** One check. `target` names the target an engine check is about, `agent` the agent a model check is about. */
export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly target?: string;
  readonly agent?: string;
  /** The e2e error code of a failure. */
  readonly code?: string;
  readonly message?: string;
  /** `config`: the config file. */
  readonly path?: string;
  /** `config`: every target the config declares, or the ones `--target` named. */
  readonly targets?: readonly { readonly name: string; readonly platform: string; readonly engine?: string }[];
  /** `model`: the agent's model. */
  readonly model?: DoctorModel;
  /** `model`: the agent's judgment model, when it is not `model`. */
  readonly judge?: DoctorModel;
  /** `model`: the `e2e login` provider whose stored login the model reads. */
  readonly login?: ProviderId;
  /** `model`: the agent's custom executor. */
  readonly executor?: string;
}

export interface DoctorReport {
  readonly schemaVersion: typeof DOCTOR_SCHEMA_VERSION;
  readonly version: string;
  /** False when any check failed. */
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly version: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config?: string | undefined;
  readonly targets?: readonly string[] | undefined;
  /** Models `--model` names as `<provider>/<model-id>`, each checked without a config entry. */
  readonly models?: readonly string[] | undefined;
  readonly headed: boolean;
  readonly checkModel: boolean;
  readonly signal: AbortSignal;
  /** Holds back what the config prints while it loads, redacted, as `e2e run` does. */
  readonly output: RunnerOutput;
  /** Where an engine's progress lines go, under the target they concern. */
  readonly notice: (targetName: string, line: string) => void;
  /** How long each engine's `doctor` hook may take; defaults to 30 seconds. */
  readonly engineTimeoutMs?: number | undefined;
}

/**
 * Runs every check: the runtime, then the config, then each selected
 * target's engine, each agent's model, and each model `--model` names. A
 * config that does not load ends the checks that read it, since the rest
 * need it; the named models still run, since they exist without one. The
 * signal ends the checks after the one it cut short.
 */
export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [nodeCheck()];
  const loaded = await withAbort(loadConfig(options), options.signal, cancelledError).then(
    (config) => ({ config }),
    (cause: unknown) => ({ failure: failed('config', cause) }),
  );
  if ('failure' in loaded) {
    checks.push(loaded.failure);
    checks.push(...(await namedModelChecks(options)));
    return doctorReport(options.version, checks);
  }
  const { config } = loaded;
  let targets: readonly ResolvedTarget[];
  try {
    targets = selectTargets(config.targets, options.targets);
  } catch (cause) {
    checks.push(failed('config', cause));
    checks.push(...(await namedModelChecks(options)));
    return doctorReport(options.version, checks);
  }
  checks.push({
    id: 'config',
    status: 'pass',
    ...(config.configPath === undefined ? {} : { path: config.configPath }),
    targets: targets.map((target) => ({ name: target.name, platform: target.platform, ...(target.engine === undefined ? {} : { engine: target.engine.name }) })),
  });
  for (const target of targets) {
    if (options.signal.aborted) return doctorReport(options.version, checks);
    checks.push(...(await engineChecks(target, config, options)));
  }
  if (!options.signal.aborted) checks.push(...(await modelChecks(config, options)));
  if (!options.signal.aborted) checks.push(...(await namedModelChecks(options)));
  return doctorReport(options.version, checks);
}

/** The report, every message redacted of the config's secrets: an engine or a provider error may quote one. */
function doctorReport(version: string, checks: readonly DoctorCheck[]): DoctorReport {
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    version,
    ok: checks.every((check) => check.status !== 'fail'),
    checks: checks.map((check) => (check.message === undefined ? check : { ...check, message: processSecrets.redact(check.message) })),
  };
}

/** A failed check of `id` carrying the e2e error code and message of `cause`. */
function failed(id: string, cause: unknown, scope: Pick<DoctorCheck, 'target'> = {}): DoctorCheck {
  return { id, status: 'fail', ...scope, ...errorOutcome(cause) };
}

/** The e2e error code and message `cause` classifies as. */
function errorOutcome(cause: unknown): { readonly code: string; readonly message: string } {
  const { code, message } = classifyError(cause);
  return { code, message };
}

/** The runtime, which passed: `bin.ts` reports the one it refuses before this module loads. Its id stays `node` on Bun too. */
function nodeCheck(): DoctorCheck {
  const message = onBun ? `Bun ${process.versions['bun']} (${SUPPORTED_BUN_RANGE})` : `Node.js ${process.versions.node} (${SUPPORTED_NODE_RANGE})`;
  return { id: 'node', status: 'pass', message };
}

/** Loads and resolves the config the way `e2e run` does. */
async function loadConfig(options: DoctorOptions): Promise<ResolvedConfig> {
  return options.output.withholdDuring(async () => {
    const discovered = discoverConfig(options.cwd, options.config);
    if (discovered.configPath === undefined) throw missingConfigError(options.cwd);
    const raw = await loadConfigModule(discovered.configPath);
    const config = resolveConfig(raw, { projectRoot: discovered.projectRoot, configPath: discovered.configPath, env: options.env, cli: {} });
    registerStaticSecrets(config.allSecrets);
    return config;
  });
}

/** What the target's engine reports through its `doctor` hook, each finding under the target. */
async function engineChecks(target: ResolvedTarget, config: ResolvedConfig, options: DoctorOptions): Promise<DoctorCheck[]> {
  const engine = target.engine;
  if (engine === undefined) return [];
  if (engine.doctor === undefined) {
    return [{ id: 'engine', status: 'skip', target: target.name, message: `engine "${engine.name}" has no doctor checks` }];
  }
  const hook = engine.doctor.bind(engine);
  const timeoutMs = options.engineTimeoutMs ?? ENGINE_DOCTOR_TIMEOUT_MS;
  // A held timer, unlike `AbortSignal.timeout`: a hook that awaits nothing
  // else must not let the process exit under it.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const pending = Promise.resolve().then(() =>
    hook({
      targetName: target.name,
      projectRoot: config.projectRoot,
      app: engineAppInfo(target.app),
      env: options.env,
      headed: options.headed,
      signal,
      log: (line) => options.notice(target.name, line),
    }),
  );
  try {
    const findings: unknown = await withAbort(pending, signal, cancelledError);
    if (!Array.isArray(findings)) throw malformedFinding(engine.name, findings);
    return findings.map((finding: unknown) => {
      if (!isEngineFinding(finding)) throw malformedFinding(engine.name, finding);
      return { id: finding.id, status: finding.status, target: target.name, ...(finding.message === undefined ? {} : { message: finding.message }) };
    });
  } catch (cause) {
    // The hook stops at the signal; waiting for it keeps doctor from exiting
    // while a protocol engine still shuts its server down.
    const timedOut = deadline.signal.aborted && !options.signal.aborted;
    await withinCleanupBudget(pending, { signal: NEVER_ABORTS, timeoutMs: ENGINE_DOCTOR_TEARDOWN_MS });
    const failure = timedOut
      ? new InfrastructureError('ENGINE_FAILURE', `engine "${engine.name}" did not finish its checks within ${budgetText(timeoutMs)}`)
      : cause;
    return [failed('engine', failure, { target: target.name })];
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `value` is an `EngineDoctorCheck`: an engine over the protocol may send anything. */
function isEngineFinding(value: unknown): value is EngineDoctorCheck {
  if (typeof value !== 'object' || value === null) return false;
  const { id, status, message } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    CHECK_ID.test(id) &&
    !RESERVED_IDS.has(id) &&
    typeof status === 'string' &&
    ENGINE_STATUSES.has(status) &&
    (message === undefined || typeof message === 'string')
  );
}

function malformedFinding(engine: string, value: unknown): InfrastructureError {
  return new InfrastructureError('ENGINE_FAILURE', `engine "${engine}" returned a malformed doctor check: ${bounded(JSON.stringify(value) ?? String(value))}`);
}

/**
 * One `model` check per agent. Without `--check-model`, a model on a stored
 * login passes or fails on that login and any other is `unknown`; with it,
 * each model answers one call per set of provider options the agents send it.
 */
async function modelChecks(config: ResolvedConfig, options: DoctorOptions): Promise<DoctorCheck[]> {
  const agents = [...config.agents];
  const sdk = agents.some(([, agent]) => agent.model !== undefined || agent.judge !== undefined) ? await loadAiSdk().then(() => undefined, (cause: unknown) => cause) : undefined;
  const calls = new Map<object, Map<string, Promise<unknown>>>();
  const call = (model: ResolvedModel, agent: ResolvedAgentConfig): Promise<unknown> => {
    let byOptions = calls.get(model.model);
    if (byOptions === undefined) {
      byOptions = new Map();
      calls.set(model.model, byOptions);
    }
    const key = callKey(agent);
    if (key === undefined) return callModel(model, agent, options.signal);
    let pending = byOptions.get(key);
    if (pending === undefined) {
      pending = callModel(model, agent, options.signal);
      byOptions.set(key, pending);
    }
    return pending;
  };
  const checks: DoctorCheck[] = [];
  for (const [name, agent] of agents) {
    if (options.signal.aborted) break;
    checks.push(await modelCheck(name, agent, sdk, options.checkModel ? call : undefined));
  }
  return checks;
}

/** What makes two agents' calls to one model the same call: their provider options and input limit. Undefined for options JSON cannot hold, which are never shared. */
function callKey(agent: ResolvedAgentConfig): string | undefined {
  try {
    return JSON.stringify([agent.providerOptions ?? null, agent.maxInputTokens]);
  } catch {
    return undefined;
  }
}

/**
 * One `model` check per model `--model` names: a subscription model whose
 * `e2e/oauth` constructor needs no config entry. It runs whether or not the
 * config loaded, and checks the stored login the constructor reads; with
 * `--check-model`, one call.
 */
async function namedModelChecks(options: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const spec of options.models ?? []) {
    if (options.signal.aborted) break;
    checks.push(await namedModelCheck(spec, options));
  }
  return checks;
}

/**
 * The `model` check of one `<provider>/<model-id>`: `INVALID_CONFIG` for a
 * name that is not a provider `e2e login` stores and a model id, else the
 * stored login, and one call with `--check-model`. A construction failure,
 * such as a missing provider package, fails the check with its own code.
 */
async function namedModelCheck(spec: string, options: DoctorOptions): Promise<DoctorCheck> {
  const slash = spec.indexOf('/');
  const provider = slash === -1 ? '' : spec.slice(0, slash);
  const modelId = slash === -1 ? '' : spec.slice(slash + 1);
  if (!isProviderId(provider) || modelId === '') {
    return failed(
      'model',
      new ConfigurationError('INVALID_CONFIG', `--model takes <provider>/<model-id> with provider one of ${PROVIDER_IDS.join(', ')}, e.g. openai/gpt-6-luna; got ${JSON.stringify(spec)}`),
    );
  }
  let instance: ModelInstance;
  try {
    instance = await constructModel(provider, modelId);
  } catch (cause) {
    return failed('model', cause);
  }
  const model: ResolvedModel = { provider: instance.provider, id: instance.modelId, model: instance };
  const login = loginOf(instance);
  const result = (status: DoctorStatus, outcome: Pick<DoctorCheck, 'code' | 'message'>): DoctorCheck => ({
    id: 'model',
    status,
    model: doctorModel(model),
    ...(login === undefined ? {} : { login }),
    ...outcome,
  });
  const credential = login === undefined ? undefined : await loginCredential(login);
  if (credential !== undefined && !credential.ok) return result('fail', { code: 'MODEL_UNAVAILABLE', message: credential.message });
  if (options.checkModel) {
    const sdk = await loadAiSdk().then(() => undefined, (cause: unknown) => cause);
    if (sdk !== undefined) return result('fail', errorOutcome(sdk));
    const failure = await callModel(model, {}, options.signal);
    if (failure !== undefined) return result('fail', errorOutcome(failure));
    return result('pass', { message: 'answered' });
  }
  if (credential !== undefined) return result('pass', { message: credential.message });
  return result('unknown', { message: 'the model reads its own credential; --check-model calls it' });
}

/** The `e2e/oauth` constructor each subscription provider's model ids come from, loaded only when a check needs it. */
async function constructModel(provider: ProviderId, modelId: string): Promise<ModelInstance> {
  switch (provider) {
    case 'openai':
      return (await import('../oauth/chatgpt.ts')).chatgpt(modelId);
    case 'github-copilot':
      return (await import('../oauth/copilot.ts')).copilot(modelId);
    case 'opencode-console':
      return (await import('../oauth/opencode-console.ts')).opencodeConsole(modelId);
    case 'spacexai':
      return (await import('../oauth/grok.ts')).grok(modelId);
  }
}

/**
 * The `model` check of one agent: its model and, when it is another one, its
 * judge, each checked on its own. An executor that brings its own agent may
 * still leave judgments to `judge`.
 */
async function modelCheck(
  name: string,
  agent: ResolvedAgentConfig,
  sdkFailure: unknown,
  call: ((model: ResolvedModel, agent: ResolvedAgentConfig) => Promise<unknown>) | undefined,
): Promise<DoctorCheck> {
  const executor = agent.executor === undefined ? {} : { executor: agent.executor.name };
  const { model } = agent;
  const judge = agent.judge === undefined || agent.judge.model === model?.model ? undefined : agent.judge;
  const roles = [...(model === undefined ? [] : [{ role: 'model', model }]), ...(judge === undefined ? [] : [{ role: 'judge', model: judge }])];
  if (roles.length === 0) {
    if (agent.executor !== undefined) {
      return { id: 'model', status: 'unknown', agent: name, ...executor, message: `executor "${agent.executor.name}" brings its own agent, which doctor does not check` };
    }
    return { id: 'model', status: 'skip', agent: name, message: 'no model configured: tests without agent steps run, agent steps fail' };
  }
  const logins = [...new Set(roles.flatMap((entry) => loginOf(entry.model.model) ?? []))];
  const result = (status: DoctorStatus, outcome: Pick<DoctorCheck, 'code' | 'message'>): DoctorCheck => ({
    id: 'model',
    status,
    agent: name,
    ...executor,
    ...(model === undefined ? {} : { model: doctorModel(model) }),
    ...(judge === undefined ? {} : { judge: doctorModel(judge) }),
    ...(logins.length === 1 ? { login: logins[0]! } : {}),
    ...outcome,
  });
  if (sdkFailure !== undefined) return result('fail', errorOutcome(sdkFailure));
  const credentials: string[] = [];
  for (const provider of logins) {
    const credential = await loginCredential(provider);
    if (!credential.ok) return result('fail', { code: 'MODEL_UNAVAILABLE', message: credential.message });
    credentials.push(credential.message);
  }
  if (call !== undefined) {
    const failures: { readonly code: string; readonly message: string }[] = [];
    for (const entry of roles) {
      const failure = await call(entry.model, agent);
      if (failure === undefined) continue;
      const { code, message } = errorOutcome(failure);
      failures.push({ code, message: roles.length === 1 ? message : `${entry.role}: ${message}` });
    }
    if (failures.length > 0) return result('fail', { code: failures[0]!.code, message: failures.map((failure) => failure.message).join('; ') });
    return result('pass', { message: roles.length === 1 ? 'answered' : 'both answered' });
  }
  if (roles.every((entry) => loginOf(entry.model.model) !== undefined)) {
    return result('pass', { message: credentials.join('; ') });
  }
  return result('unknown', { message: 'the model reads its own credential; --check-model calls it' });
}

function doctorModel(model: ResolvedModel): DoctorModel {
  return { provider: model.provider, modelId: model.id };
}

/** The credential `provider`'s calls read: its API key variable when set, else the stored login, which must be there. */
async function loginCredential(provider: ProviderId): Promise<{ readonly ok: boolean; readonly message: string }> {
  const variable = getProvider(provider).apiKeyEnv;
  if (variable !== undefined && apiKeyFor(provider) !== undefined) return { ok: true, message: `${variable} is set` };
  try {
    if ((await defaultCredentialStore().get(provider)) !== undefined) return { ok: true, message: `the stored ${provider} login is present` };
    return { ok: false, message: `no stored ${provider} login: ${loginHint(provider)}` };
  } catch (cause) {
    return { ok: false, message: `the ${provider} login could not be read: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/** What one model call reads off whoever asked for it: the provider options and input cap. */
interface CallProfile {
  readonly maxInputTokens?: number | undefined;
  readonly providerOptions?: NonNullable<ResolvedAgentConfig['providerOptions']> | undefined;
}

/**
 * One small call to `model` with the agent's provider options, resolving to
 * the failure or undefined. A reply that is not the JSON asked for, or a
 * refusal, still proves the model answered: the adapter throws a provider
 * failure for a call that ended on an error.
 */
async function callModel(model: ResolvedModel, agent: CallProfile, signal: AbortSignal): Promise<unknown> {
  try {
    await createModelAdapter(model).generate({
      system: 'You are checking that this model is reachable.',
      prompt: 'Reply with the JSON object {"ok": true} and nothing else.',
      schemaName: 'doctor',
      schema: undefined,
      validate: (value) => ({ ok: true, value }),
      maxOutputTokens: 1024,
      // A named model brings no agent cap; it gets the same per-call input ceiling a default agent gets.
      maxInputTokens: agent.maxInputTokens ?? DEFAULT_LIMITS.maxModelTokensPerCall,
      providerOptions: agent.providerOptions,
      signal,
      timeoutMs: MODEL_CALL_TIMEOUT_MS,
      maxRetries: MODEL_CALL_RETRIES,
    });
    return undefined;
  } catch (cause) {
    if (cause instanceof ModelOutputInvalidError || (isAgentError(cause) && cause.code === 'MODEL_REFUSED')) return undefined;
    if (isAgentError(cause) && cause.code === 'STEP_TIMEOUT') {
      return new AgentError('MODEL_PROVIDER_FAILED', `the model did not answer within ${budgetText(MODEL_CALL_TIMEOUT_MS)}`, { cause });
    }
    return cause;
  }
}

const MARKS: Readonly<Record<DoctorStatus, string>> = {
  pass: picocolors.green('✓'),
  warn: picocolors.yellow('!'),
  fail: picocolors.red('✗'),
  skip: picocolors.dim('-'),
  unknown: picocolors.dim('?'),
};

/** The report for a person: one line per check, then the verdict. */
export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((check) => check.id.length));
  const lines = report.checks.map((check) => `${MARKS[check.status]} ${check.id.padEnd(width)}  ${bounded(describe(check).replaceAll(/\s+/g, ' ').trim())}`);
  const failures = report.checks.filter((check) => check.status === 'fail').length;
  const verdict = failures === 0 ? picocolors.green('e2e run can start here') : picocolors.red(`${String(failures)} ${failures === 1 ? 'check' : 'checks'} failed`);
  return `${lines.join('\n')}\n\n${verdict}\n`;
}

function describe(check: DoctorCheck): string {
  const scope = check.target !== undefined ? `[${check.target}] ` : check.agent !== undefined ? `[${check.agent}] ` : '';
  const parts: string[] = [];
  if (check.path !== undefined) parts.push(check.path);
  if (check.targets !== undefined) parts.push(`targets: ${check.targets.map((target) => `${target.name} (${target.engine ?? target.platform})`).join(', ')}`);
  if (check.model !== undefined) parts.push(modelLabel({ provider: check.model.provider, id: check.model.modelId }));
  if (check.judge !== undefined) parts.push(`judge ${modelLabel({ provider: check.judge.provider, id: check.judge.modelId })}`);
  if (check.executor !== undefined && (check.model !== undefined || check.judge !== undefined)) parts.push(`executor ${check.executor}`);
  if (check.message !== undefined) parts.push(check.code === undefined ? check.message : `${check.code}: ${check.message}`);
  return `${scope}${parts.join(' · ')}`;
}
