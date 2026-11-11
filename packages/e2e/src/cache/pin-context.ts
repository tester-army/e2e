/**
 * Per-attempt pinned steps: which of the attempt's `agent.act()` steps are
 * pinned, and what `--pin` and an empty `steps: []` ask the runner to pin.
 *
 * Built by the runner once per attempt beside the cache context, and
 * independent of it: a pinned step replays with the replay cache off, and
 * `--pin` records with the cache in any mode. Nothing here writes a file;
 * a worker stages what to pin, the attempt settles it, and the runner
 * writes the steps files and test files once the run ends, since several
 * workers may run the tests of one file.
 */

import path from 'node:path';
import { REPLAY_POLICY_VERSION } from './relocate.ts';
import {
  buildTraceCacheKey,
  createCallIndexer,
  keyContext,
  projectIdentity,
  traceCallSignature,
  type CacheAgentIdentity,
  type CacheTargetIdentity,
} from './identity.ts';
import { canonicalJson } from '../internal/ids.ts';
import type { SourceLocation } from '../internal/source.ts';
import type { JsonValue } from '../types.ts';
import {
  loadPinsBook,
  pinIdKey,
  pinnedStep,
  pinsFileFor,
  readInlineSteps,
  type AttemptPinWrites,
  type PinnedStepId,
  type PinSkip,
  type PinsBook,
  type PinWrite,
} from './pins.ts';
import type { ActionTrace, TraceKeyContext, TraceProvenance } from './trace.ts';

/**
 * What `--pin` asks of the steps the run selects: `none` writes nothing,
 * `new` pins each step that is not pinned yet, and `all` records every
 * step again, pinned or not.
 */
export type PinUpdate = 'none' | 'new' | 'all';

/** How one step meets its pin. */
export type PinPlan =
  /** Not pinned, and nothing to pin: the step runs as any other. */
  | { readonly kind: 'none' }
  /** Pinned: the step replays `trace` or fails. `recordedWith` is absent for actions a test wrote by hand. */
  | {
      readonly kind: 'replay';
      readonly source: 'sidecar' | 'inline';
      readonly trace: ActionTrace;
      readonly recordedWith?: TraceKeyContext;
    }
  /** Pinned to something that cannot replay: the step fails with `reason`. */
  | { readonly kind: 'stale'; readonly source: 'sidecar' | 'inline'; readonly reason: string }
  /** The step runs as any other, and its confirmed recording is pinned. */
  | { readonly kind: 'record'; readonly inline: boolean };

/** One step's claim: who it is, as its pin is looked up and written. */
export interface PinClaim {
  readonly id: PinnedStepId;
  /** The context this run would record the step with. */
  readonly context: TraceKeyContext;
  /** The step as a recording names it (`ActionTrace.recordedFor`), for a recording made with the cache off. */
  readonly step: TraceProvenance;
}

/** A recording held back until the attempt confirms it, or why the step will not be pinned. */
export type StagedPin = {
  readonly stepIndex: number;
  readonly claim: PinClaim;
  readonly inline: boolean;
} & ({ readonly trace: ActionTrace } | { readonly skipped: string });

export interface AttemptPins {
  readonly update: PinUpdate;
  /** The test file, project-relative with `/` separators. */
  readonly testFile: string;
  /** The steps file this attempt's test reads, as the project names it. */
  readonly file: string;
  /** Whether an empty `steps: []` records (false in CI, which writes nothing). */
  readonly inlineWrites: boolean;
  /**
   * Claims one step's identity, advancing the occurrence count of its
   * instruction and params for its agent, as the cache key does. One claim
   * per dispatched act step, in order.
   */
  claim(instruction: string, params: Readonly<Record<string, JsonValue>>, agent: CacheAgentIdentity): PinClaim;
  /** How the claimed step meets its pin; `inline` is the call's `steps` option, when it has one. */
  plan(claim: PinClaim, inline: readonly unknown[] | undefined): Promise<PinPlan>;
  readonly staged: StagedPin[];
}

/**
 * Builds one attempt's pins. `inlineWrites` is false in CI: an empty
 * `steps: []` is a step to record, and CI writes nothing, so there it is a
 * step pinned to nothing.
 */
export function createAttemptPins(options: {
  readonly projectRoot: string;
  readonly projectId: string;
  /** The test file, project-relative with `/` separators. */
  readonly testFile: string;
  readonly testId: string;
  readonly titlePath: readonly string[];
  readonly target: CacheTargetIdentity;
  readonly update: PinUpdate;
  readonly inlineWrites: boolean;
  /** Masks registered secret values in the labels a steps file spells out: a title may interpolate one. The same on every run, so a lookup finds what a run wrote. */
  readonly redact: (text: string) => string;
}): AttemptPins {
  const file = pinsFileFor(options.testFile);
  const absolute = path.resolve(options.projectRoot, file);
  let book: Promise<PinsBook> | undefined;
  const project = projectIdentity(options.projectId);
  const indexers = new Map<string, ReturnType<typeof createCallIndexer>>();
  const test = options.titlePath.map((title) => options.redact(title));
  const targetLabel = options.redact(options.target.targetId);
  return {
    update: options.update,
    testFile: options.testFile,
    file,
    inlineWrites: options.inlineWrites,
    claim: (instruction, params, agent) => {
      const signature = traceCallSignature('act', instruction, params);
      const agentKey = canonicalJson([agent.name, agent.context ?? '']);
      const indexer = indexers.get(agentKey) ?? createCallIndexer();
      indexers.set(agentKey, indexer);
      const callIndex = indexer(signature);
      const key = buildTraceCacheKey({ project, testId: options.testId, target: options.target, signature, callIndex, agent, policyVersion: REPLAY_POLICY_VERSION });
      return {
        id: { test, target: targetLabel, agent: options.redact(agent.name), instruction, params, callIndex },
        context: keyContext(key),
        step: {
          testId: options.testId,
          targetId: options.target.targetId,
          instructionDigest: signature.instructionDigest,
          paramsDigest: signature.paramsDigest,
          callIndex,
          agent: agent.name,
        },
      };
    },
    plan: async (claim, inline) => {
      book ??= loadPinsBook(absolute);
      return planPin(await book, claim, inline, options.update, options.inlineWrites, file);
    },
    staged: [],
  };
}

function planPin(book: PinsBook, claim: PinClaim, inline: readonly unknown[] | undefined, update: PinUpdate, inlineWrites: boolean, file: string): PinPlan {
  const source = inline === undefined ? 'sidecar' : 'inline';
  if (book.status === 'unreadable') return { kind: 'stale', source, reason: `the steps file ${file} cannot be read: ${book.reason}` };
  const entry = book.status === 'read' ? book.entries.get(pinIdKey(claim.id)) : undefined;
  if (inline !== undefined) {
    if (inline.length === 0 || (update === 'all' && inlineWrites)) {
      return inlineWrites ? { kind: 'record', inline: true } : { kind: 'stale', source, reason: 'its steps option is empty, and this run records nothing (CI, or a session outside e2e run)' };
    }
    const actions = readInlineSteps(inline);
    if (actions === undefined) return { kind: 'stale', source, reason: 'its steps option is not a list of recorded actions this runner can replay' };
    if (entry?.status === 'unreadable') return { kind: 'stale', source, reason: `${file} holds an entry for it no runner can replay` };
    // The steps file keeps the rest of an inline step's recording; actions
    // the test wrote with no such entry replay with nothing to check after.
    if (entry?.status === 'ok' && entry.step.inline === true) {
      return { kind: 'replay', source, trace: { ...entry.step.trace, actions }, recordedWith: entry.step.recordedWith };
    }
    return { kind: 'replay', source, trace: { actions, executor: { name: 'steps' }, summary: 'ran the steps the test holds' } };
  }
  if (update === 'all') return { kind: 'record', inline: false };
  if (entry?.status === 'unreadable') return { kind: 'stale', source, reason: `${file} holds an entry for it no runner can replay` };
  if (entry?.status === 'ok' && entry.step.inline !== true) {
    return { kind: 'replay', source, trace: entry.step.trace, recordedWith: entry.step.recordedWith };
  }
  // An inline entry whose call no longer holds `steps` pins nothing: its actions went with the option.
  return update === 'new' ? { kind: 'record', inline: false } : { kind: 'none' };
}

/** How an attempt ended, as its pins read it. */
export interface PinSettlement {
  readonly passed: boolean;
  /** Steps before this index were verified by a passing check. */
  readonly lastVerifiedStepIndex: number;
  /** Where each step was called from, by step index. */
  readonly sources: ReadonlyMap<number, SourceLocation>;
  readonly testFile: string;
}

/**
 * What the attempt asks the runner to pin. A recording is pinned only when
 * the attempt passed and a check passed after its step, the rule the replay
 * cache confirms a recording by: an act's own verdict is its executor's
 * opinion. Everything else `--pin` asked for is listed with why it was not.
 */
export function settleStagedPins(pins: AttemptPins, settlement: PinSettlement): AttemptPinWrites | undefined {
  const staged = pins.staged.splice(0);
  if (staged.length === 0) return undefined;
  const writes: PinWrite[] = [];
  const skipped: PinSkip[] = [];
  const skip = (pin: StagedPin, reason: string) => skipped.push({ file: settlement.testFile, test: pin.claim.id.test, instruction: pin.claim.id.instruction, reason });
  for (const pin of staged) {
    if ('skipped' in pin) {
      skip(pin, pin.skipped);
      continue;
    }
    if (!settlement.passed) {
      skip(pin, 'the test did not pass');
      continue;
    }
    if (pin.stepIndex >= settlement.lastVerifiedStepIndex) {
      skip(pin, 'no check passed after the step, so nothing confirmed its recording');
      continue;
    }
    const source = settlement.sources.get(pin.stepIndex);
    if (pin.inline && source === undefined) {
      skip(pin, 'the stack did not say where the call is');
      continue;
    }
    writes.push({
      file: settlement.testFile,
      step: pinnedStep(pin.claim.id, pin.claim.context, pin.trace, pin.inline),
      ...(pin.inline && source !== undefined ? { inline: { file: source.file, line: source.line, column: source.column } } : {}),
    });
  }
  return { writes, skipped };
}
