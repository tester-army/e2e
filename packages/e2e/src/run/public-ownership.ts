import { currentAttempt } from '../expect/attempt.ts';
import { ConfigurationError, InfrastructureError } from '../internal/errors.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { onBun } from '../internal/runtime.ts';

interface RunnerOwners {
  suite: object | undefined;
  readonly hosts: Set<object>;
}

const slot = realmSlot<RunnerOwners>('e2e.public-runner.owners.v1');

/** Public runner copies in isolated realms share one set of process owners. */
function owners(): RunnerOwners {
  let state = slot.get(globalThis);
  if (state === undefined) {
    state = { suite: undefined, hosts: new Set() };
    slot.set(globalThis, state);
  }
  return state;
}

/**
 * Refuses e2e/runner on Bun: a run there keeps its config's secret
 * references and output apart by async context, which Bun does not carry
 * into a module's top level (`config/bun-loader.ts`).
 */
export function refuseBun(): void {
  if (onBun) throw new InfrastructureError('NODE_UNSUPPORTED', 'e2e/runner needs Node.js: on Bun, run tests with the e2e CLI');
}

/** Reserves the process before a suite can change registries or claim output. */
export function reserveSuiteRun(): () => void {
  refuseBun();
  const state = owners();
  if (state.suite !== undefined) throw new ConfigurationError('RUNNER_BUSY', 'a public run is already in progress; await it before starting another');
  if (state.hosts.size > 0) throw new ConfigurationError('RUNNER_BUSY', 'a hosted runner is still open; close it before starting a suite');
  if (currentAttempt() !== undefined) throw new ConfigurationError('RUNNER_BUSY', 'an attempt is still running; close it before starting a suite');
  const owner = {};
  state.suite = owner;
  return () => { if (state.suite === owner) state.suite = undefined; };
}

/** Holds a host's process ownership from before config loading through close. */
export function reserveHostedRun(): () => void {
  refuseBun();
  const state = owners();
  if (state.suite !== undefined) throw new ConfigurationError('RUNNER_BUSY', 'a suite is running; await it before opening a host');
  if (currentAttempt()?.owner === 'suite') throw new ConfigurationError('RUNNER_BUSY', 'a suite attempt is still running; await it before opening a host');
  const owner = {};
  state.hosts.add(owner);
  return () => { state.hosts.delete(owner); };
}
