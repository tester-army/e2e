/** Serial-group execution: one shared session per group attempt. */

import type { TargetSession } from '../engine/surface.ts';
import {
  classifyError,
  ConfigurationError,
  serializeError,
  type SerializedError,
} from '../internal/errors.ts';
import { canonicalDigest, timestamp, uuidv7 } from '../internal/ids.ts';
import type { CollectedTest } from '../collect/collect.ts';
import { groupTitles, type RegisteredTest } from '../collect/registry.ts';
import { pairRecordings, type SkipInfo, type TestTargetPair } from '../collect/select.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { ArtifactStore } from '../types.ts';
import { attemptSegments, createAttemptArtifacts, resultSegment } from './artifacts.ts';
import type { AttemptContext, ClosingRecord, SessionClose, SessionPlan } from './execute.ts';
import type { ArtifactSink } from './fixtures.ts';
import type { StepRecord } from './steps.ts';
import { findRegistered, type FileRef, type Realm, RealmManager } from './realm.ts';
import type { AttemptRecord, ResultRecord, ResultStatus, SerialAttemptRecord, SerialGroupRecord, SerialMemberRecord, FailedStatus } from './records.ts';
import { isFailedStatus } from './records.ts';
import { isRetryEligible, retryVerdict, runWithRetries } from './retry.ts';
import { interruptedSkip, pairResult } from './units.ts';

/**
 * One shared session for a serial-group attempt: members preserve app state,
 * so a screen an earlier member reached stays current for later members.
 */
export interface SharedSerialSession {
  readonly session: TargetSession;
  /**
   * The group attempt's report id. Member artifacts are filed under this
   * attempt in the report, so a member's store identity uses it rather than
   * the member's own private attempt id.
   */
  readonly attemptId: string;
  /**
   * Report segments of the group attempt directory. The shared session writes
   * every artifact there, so members resolve artifact paths against it rather
   * than against their own attempt directory.
   */
  readonly artifactSegments: readonly string[];
  /** Steps completed by earlier members, so later members see them as prior context. */
  readonly priorSteps: StepRecord[];
  /** Executor scratch memory shared by every member, as the ledger is. */
  readonly memory: Map<string, unknown>;
}

/** Executor capabilities the serial runner borrows. */
export interface SerialHost {
  readonly target: ResolvedTarget;
  readonly artifactsRoot: string;
  /** See `TargetExecutorOptions.rerunDir`. */
  readonly rerunDir: string | undefined;
  readonly runId: string;
  /** The configured artifact store, so group-owned artifacts (the shared trace) upload like any other. */
  readonly artifactStore: ArtifactStore | undefined;
  readonly interruptSignal: AbortSignal;
  readonly realms: RealmManager;
  launchSession(
    plan: SessionPlan,
    attemptId: string,
    artifactsDir: string,
    signal: AbortSignal,
  ): Promise<TargetSession>;
  closeSession(
    session: TargetSession,
    close: SessionClose,
    record: ClosingRecord,
    sink: ArtifactSink,
    secondaryErrors: SerializedError[],
  ): Promise<void>;
  runAttempt(
    pair: TestTargetPair,
    registered: RegisteredTest,
    realm: Realm,
    attemptIndex: number,
    context: AttemptContext,
  ): Promise<AttemptRecord>;
  emit(result: ResultRecord): void;
  /** Announces one member about to execute; the previous member is done by then. */
  pairStarted(pair: TestTargetPair): void;
  /**
   * Announces the finished group before its members' results go out. Member
   * results carry no attempts of their own, so a consumer reads each member's
   * steps, duration, and error from the group it has already seen.
   */
  emitSerialGroup(group: SerialGroupRecord): void;
  /**
   * Streams one member that finished in the group attempt running now, so a
   * worker that dies before the group ends does not take it along.
   */
  serialMemberFinished(groupId: string, attempt: SerialAttemptStart, member: SerialMemberRecord): void;
  /** Streams one finished group attempt, for the same reason. */
  serialAttemptFinished(groupId: string, run: SerialAttemptRun): void;
}

/** The identity of a group attempt, known from its start. */
export type SerialAttemptStart = Pick<SerialAttemptRecord, 'id' | 'index' | 'startedAt'>;

/** One group attempt as it ended, and whether it got as far as its members. */
export interface SerialAttemptRun {
  readonly record: SerialAttemptRecord;
  /**
   * False when the attempt stopped before any member ran (its file would not
   * load, its session would not launch). Such a retry keeps the members'
   * verdicts from the attempt before it.
   */
  readonly reachedMembers: boolean;
}

/** The report id of one serial group variant: a group runs once per agent and per repeat. */
export function serialGroupId(serialId: string, targetName: string, agent: string, repeat: number): string {
  return canonicalDigest(
    repeat === 0 ? { serialId, targetId: targetName, agent } : { serialId, targetId: targetName, agent, repeat },
  );
}

/** Runs one serial unit to completion and emits every member result. */
export async function runSerialUnit(
  host: SerialHost,
  members: readonly TestTargetPair[],
  file: FileRef,
): Promise<SerialGroupRecord> {
  const group = newSerialGroup(members, host.target);
  const runs: SerialAttemptRun[] = [];
  const finalStatus = await runWithRetries(
    members[0]!.options.retries + 1,
    host.interruptSignal,
    async (attemptIndex) => {
      const run = await runSerialAttempt(host, group.id, members, file, attemptIndex);
      runs.push(run);
      group.attempts.push(run.record);
      host.serialAttemptFinished(group.id, run);
      // A beforeAll failure is not retry-eligible: the
      // attempt stands as recorded and the retry loop stops here.
      if (run.record.error?.code === 'HOOK_FAILED') return undefined;
      return run.record;
    },
  );

  if (group.attempts.length === 0) {
    group.status = 'skipped';
    group.skip = interruptedSkip(host.interruptSignal);
  } else {
    group.status = finalStatus;
  }

  host.emitSerialGroup(group);
  for (const result of memberResults(group, members, runs)) host.emit(result);
  return group;
}

/** A group record with no attempts yet. */
function newSerialGroup(members: readonly TestTargetPair[], target: ResolvedTarget): SerialGroupRecord {
  const first = members[0]!;
  const serialId = first.test.serialId!;
  // Every member of a unit runs as the same agent (selection guarantees it),
  // so the group is one variant of the flow and is identified as such.
  const { agent, repeat } = first;
  return {
    id: serialGroupId(serialId, target.name, agent, repeat),
    serialId,
    declarationIndex: first.test.declarationIndex,
    file: first.test.file,
    titlePath: serialTitlePath(first.test),
    targetId: target.name,
    platform: target.platform,
    agent,
    repeat,
    memberTestIds: members.map((member) => member.test.id),
    status: 'failed',
    attempts: [],
  };
}

/**
 * Each member's result once its group is decided. Members carry no attempts
 * of their own; the verdict is the member's record in the last attempt that
 * counts. A retry the run interrupted, or one that never reached its
 * members, keeps the verdict before it.
 */
function memberResults(
  group: SerialGroupRecord,
  members: readonly TestTargetPair[],
  runs: readonly SerialAttemptRun[],
): ResultRecord[] {
  const verdicts = new Map<string, SerialMemberRecord>();
  for (const [attemptIndex, run] of runs.entries()) {
    const cutRetry = attemptIndex > 0 && (run.record.status === 'interrupted' || !run.reachedMembers);
    if (!cutRetry) for (const member of run.record.members) verdicts.set(member.testId, member);
  }
  return members.map((member) => {
    const memberRecord = verdicts.get(member.test.id);
    let status: ResultStatus;
    let skip: SkipInfo | undefined;
    // A member that skipped itself stays skipped whatever the group did: a
    // passing group says the rest of the flow held, not that this member ran.
    if (memberRecord?.status === 'skipped') {
      status = 'skipped';
      skip = memberRecord.skip;
    } else if (group.status === 'passed' || group.status === 'flaky') {
      status = group.status;
    } else if (memberRecord === undefined) {
      status = 'skipped';
      skip = { cause: 'serial-predecessor-failed', reason: 'group attempt did not reach this member' };
    } else {
      status = memberRecord.status;
    }
    return pairResult(member, {
      status,
      selected: true,
      ...(skip !== undefined ? { skip } : {}),
      attempts: [],
      serialGroupId: group.id,
    });
  });
}

/** A serial group decided without its worker's word: the record and its members' results. */
interface SettledSerialGroup {
  readonly group: SerialGroupRecord;
  readonly results: readonly ResultRecord[];
}

/**
 * What the runner heard of one serial group a worker is running: the
 * attempts it finished, and the members finished so far in the attempt
 * running now. When the worker dies before reporting the group, this is
 * what the report keeps.
 */
export class SerialGroupProgress {
  private readonly finished: SerialAttemptRun[] = [];
  private current: SerialAttemptStart | undefined;
  private currentMembers: SerialMemberRecord[] = [];
  /** The member whose body is running now, by test id, until its record arrives. */
  private running: string | undefined;

  /** A member of the group announced its start. */
  memberStarted(testId: string): void {
    this.running = testId;
  }

  /** A member finished in the attempt running now. */
  memberFinished(attempt: SerialAttemptStart, member: SerialMemberRecord): void {
    this.current = attempt;
    this.currentMembers.push(member);
    if (this.running === member.testId) this.running = undefined;
  }

  /** A group attempt finished; the next one starts empty. */
  attemptFinished(run: SerialAttemptRun): void {
    this.finished.push(run);
    this.current = undefined;
    this.currentMembers = [];
    this.running = undefined;
  }

  /**
   * The group after its worker died with `error`, or undefined when the
   * runner heard nothing of it running. The finished attempts stand, and the
   * attempt in flight fails: the member whose body was running ends `status`
   * with `error` (`timed-out` when the watchdog killed a worker that hung in
   * it) and the ones after it skip. A crash between members (a hook,
   * the session closing) fails the attempt and leaves its finished members
   * as they were; one in a retry before any member ran fails the first, as a
   * launch failure does. A crash after the last attempt, when no retry
   * follows it, is recorded on that attempt.
   */
  crashed(
    members: readonly TestTargetPair[],
    target: ResolvedTarget,
    error: SerializedError,
    status: 'failed' | 'timed-out',
  ): SettledSerialGroup | undefined {
    const last = this.finished.at(-1);
    if (!this.inFlight) {
      if (last === undefined) return undefined;
      if (!retryFollows(last.record, this.finished.length, members)) {
        const closed: SerialAttemptRun = {
          ...last,
          record: { ...last.record, secondaryErrors: [...last.record.secondaryErrors, error], cleanup: 'forced' },
        };
        return this.settled([...this.finished.slice(0, -1), closed], members, target);
      }
      const record = this.attemptInFlight('failed', error);
      endBeforeMembers(record, members, error, NEVER_INTERRUPTED);
      return this.settled([...this.finished, { record, reachedMembers: false }], members, target);
    }
    const next = this.currentMembers.length;
    const wasRunning = this.running !== undefined && this.running === members[next]?.test.id;
    const record = this.attemptInFlight(wasRunning ? status : 'failed', error);
    const skip: SkipInfo = wasRunning
      ? predecessorFailed(next)
      : { cause: 'infrastructure-unavailable', reason: 'worker process exited during this group attempt' };
    for (const [memberIndex, member] of members.entries()) {
      if (memberIndex < next) continue;
      record.members.push(
        wasRunning && memberIndex === next
          ? memberFailedWith(record, memberIndex, member.test.id, error, status)
          : skippedMember(record.id, memberIndex, member.test.id, skip),
      );
    }
    return this.settled([...this.finished, { record, reachedMembers: true }], members, target);
  }

  /**
   * The group after the run's interrupt stopped its worker, or undefined
   * when the runner heard nothing of it running. The finished attempts
   * stand, and an attempt in flight is interrupted: the members it finished
   * keep their records and the rest skip with `skip`. The verdict is the one
   * those attempts reach, as for a retry the interrupt cut short.
   */
  interrupted(members: readonly TestTargetPair[], target: ResolvedTarget, skip: SkipInfo): SettledSerialGroup | undefined {
    if (!this.inFlight) return this.finished.length === 0 ? undefined : this.settled(this.finished, members, target);
    const record = this.attemptInFlight('interrupted', undefined);
    for (const [memberIndex, member] of members.entries()) {
      if (memberIndex >= this.currentMembers.length) record.members.push(skippedMember(record.id, memberIndex, member.test.id, skip));
    }
    return this.settled([...this.finished, { record, reachedMembers: true }], members, target);
  }

  /** Whether a member of the attempt in flight started or finished. */
  private get inFlight(): boolean {
    return this.currentMembers.length > 0 || this.running !== undefined;
  }

  /** The record of the attempt in flight as it stood, with the members it finished. */
  private attemptInFlight(status: SerialAttemptRecord['status'], error: SerializedError | undefined): SerialAttemptRecord {
    return {
      id: this.current?.id ?? uuidv7(),
      index: this.finished.length,
      status,
      startedAt: this.current?.startedAt ?? timestamp(),
      durationMs: 0,
      members: [...this.currentMembers],
      artifacts: [],
      ...(error === undefined ? {} : { error }),
      secondaryErrors: [],
      cleanup: 'forced',
    };
  }

  private settled(
    runs: readonly SerialAttemptRun[],
    members: readonly TestTargetPair[],
    target: ResolvedTarget,
  ): SettledSerialGroup {
    const group = newSerialGroup(members, target);
    group.status = retryVerdict(runs.map((run) => run.record));
    group.attempts = runs.map((run) => run.record);
    return { group, results: memberResults(group, members, runs) };
  }
}

/**
 * Whether the group retries after `record`, its attempt number `attempts`:
 * the retry policy allows it, and a hook failure never retries.
 */
function retryFollows(record: SerialAttemptRecord, attempts: number, members: readonly TestTargetPair[]): boolean {
  return attempts < members[0]!.options.retries + 1 && isRetryEligible(record) && record.error?.code !== 'HOOK_FAILED';
}

/** An abort signal that never fires. */
const NEVER_INTERRUPTED = new AbortController().signal;

async function runSerialAttempt(
  host: SerialHost,
  groupId: string,
  members: readonly TestTargetPair[],
  file: FileRef,
  attemptIndex: number,
): Promise<SerialAttemptRun> {
  const attemptId = uuidv7();
  const startedAt = timestamp();
  const startedMs = Date.now();
  const memberRecords: SerialMemberRecord[] = [];
  const first = members[0]!;
  const recordings = pairRecordings(first, attemptIndex);
  const artifactSegments = attemptSegments(
    host.rerunDir,
    resultSegment({ id: serialGroupId(first.test.serialId!, host.target.name, first.agent, first.repeat), file: first.test.file, titlePath: serialTitlePath(first.test) }),
    attemptIndex,
  );
  const artifacts = createAttemptArtifacts({
    artifactsRoot: host.artifactsRoot,
    segments: artifactSegments,
    attemptId,
    ...(host.artifactStore === undefined ? {} : { store: host.artifactStore }),
    // A group-owned artifact is identified by the group, the same identity
    // its report path uses.
    identity: { runId: host.runId, testId: first.test.serialId ?? first.test.id, attemptId },
  });
  const record: SerialAttemptRecord = {
    id: attemptId,
    index: attemptIndex,
    status: 'passed',
    startedAt,
    durationMs: 0,
    members: memberRecords,
    artifacts: artifacts.records,
    secondaryErrors: [],
    trace: recordings.trace,
    cleanup: 'complete',
  };
  const start: SerialAttemptStart = { id: attemptId, index: attemptIndex, startedAt };
  /** Records one member and streams it, so a worker that dies later in the attempt does not take it along. */
  const finishMember = (member: SerialMemberRecord): void => {
    memberRecords.push(member);
    host.serialMemberFinished(groupId, start, member);
  };

  let realm: Realm;
  try {
    realm = await host.realms.create(file);
  } catch (cause) {
    endBeforeMembers(record, members, serializeError(classifyError(cause), { phase: 'collection' }), host.interruptSignal);
    record.durationMs = Date.now() - startedMs;
    return { record, reachedMembers: false };
  }

  let shared: SharedSerialSession;
  try {
    shared = {
      // Members share the group's session and recordings, which selection resolved alike for each.
      session: await host.launchSession({ session: first.options.session, video: recordings.video, traced: recordings.trace !== undefined }, attemptId, artifacts.dir, host.interruptSignal),
      attemptId,
      artifactSegments,
      priorSteps: [],
      memory: new Map(),
    };
  } catch (cause) {
    endBeforeMembers(record, members, serializeError(classifyError(cause), { phase: 'launch' }), host.interruptSignal);
    record.durationMs = Date.now() - startedMs;
    await host.realms.leave(realm);
    return { record, reachedMembers: false };
  }

  let skipRemaining: SkipInfo | undefined;
  let hookFailure: SerializedError | undefined;
  for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
    const member = members[memberIndex]!;
    const memberId = `${attemptId}:member:${memberIndex}`;
    if (skipRemaining === undefined && host.interruptSignal.aborted) {
      skipRemaining = interruptedMemberSkip(host.interruptSignal);
    }
    if (skipRemaining !== undefined) {
      finishMember(skippedMember(attemptId, memberIndex, member.test.id, skipRemaining));
      continue;
    }
    const registered = findRegistered(realm, member.test);
    if (registered === undefined) {
      finishMember({
        id: memberId,
        index: memberIndex,
        testId: member.test.id,
        status: 'failed',
        startedAt: timestamp(),
        durationMs: 0,
        steps: [],
        error: serializeError(
          new ConfigurationError('COLLECTION_ERROR', 'member disappeared on re-import'),
        ),
        secondaryErrors: [],
      });
      skipRemaining = predecessorFailed(memberIndex);
      continue;
    }
    // Suite scopes enter per member, exactly as for ordinary tests: a
    // beforeAll failure skips this member and, since later members build on
    // its screen, every member after it.
    hookFailure = await host.realms.enterScopes(realm, registered);
    if (hookFailure !== undefined) {
      skipRemaining = { cause: 'hook-failed', reason: hookFailure.message };
      finishMember(skippedMember(attemptId, memberIndex, member.test.id, skipRemaining));
      continue;
    }
    host.pairStarted(member);
    const memberAttempt = await host.runAttempt(member, registered, realm, attemptIndex, {
      kind: 'serial',
      shared,
    });
    shared.priorSteps.push(...memberAttempt.steps);
    finishMember({
      id: memberId,
      index: memberIndex,
      testId: member.test.id,
      status: memberAttempt.status,
      startedAt: memberAttempt.startedAt,
      durationMs: memberAttempt.durationMs,
      steps: memberAttempt.steps,
      ...(memberAttempt.error !== undefined ? { error: memberAttempt.error } : {}),
      ...(memberAttempt.failure !== undefined ? { failure: memberAttempt.failure } : {}),
      ...(memberAttempt.skip !== undefined ? { skip: memberAttempt.skip } : {}),
      secondaryErrors: memberAttempt.secondaryErrors,
    });
    record.artifacts.push(...memberAttempt.artifacts);
    if (memberAttempt.environment !== undefined) record.environment = memberAttempt.environment;
    // A member that skipped itself decided nothing about the shared state; the rest run on.
    if (isFailedStatus(memberAttempt.status)) skipRemaining = predecessorFailed(memberIndex);
    // Nested scopes close when their last member is done, as for ordinary
    // tests. A failed afterAll discards the suite instance, and the group
    // attempt is that instance: remaining members skip, as after a failed
    // beforeAll, and the attempt fails without a retry.
    const teardownFailure = await host.realms.leaveFinished(realm, members.slice(memberIndex + 1));
    if (teardownFailure !== undefined && skipRemaining === undefined) {
      hookFailure = teardownFailure;
      skipRemaining = { cause: 'hook-failed', reason: teardownFailure.message };
    }
  }
  await host.realms.leave(realm);
  // The group's verdict is reached before its session closes: the close reads
  // it to decide what the shared recording is worth.
  const failedMember = memberRecords.find(isFailedMember);
  if (host.interruptSignal.aborted) {
    record.status = 'interrupted';
  } else if (failedMember === undefined && hookFailure !== undefined) {
    // No member failed, but a suite hook did: the attempt is a failure the
    // hook explains, never a pass over skipped members.
    record.status = 'failed';
    record.error = hookFailure;
  } else if (failedMember === undefined) {
    record.status = 'passed';
  } else {
    record.status = failedMember.status;
    if (failedMember.error !== undefined) record.error = failedMember.error;
  }
  await host.closeSession(shared.session, { attemptId, video: recordings.video }, record, artifacts.sink, record.secondaryErrors);
  await artifacts.settle();
  record.durationMs = Date.now() - startedMs;
  return { record, reachedMembers: true };
}

/**
 * Ends a group attempt that stopped before any member ran (its file would not
 * load, its session would not launch). The first member fails with the
 * attempt's error, as an ordinary test whose attempt failed the same way
 * would, and the rest skip behind it. When the run's interrupt is what
 * stopped it, the attempt is interrupted and every member skips.
 */
function endBeforeMembers(
  record: SerialAttemptRecord,
  members: readonly TestTargetPair[],
  error: SerializedError,
  interruptSignal: AbortSignal,
): void {
  record.error = error;
  if (interruptSignal.aborted) {
    record.status = 'interrupted';
    const skip = interruptedMemberSkip(interruptSignal);
    members.forEach((member, memberIndex) => record.members.push(skippedMember(record.id, memberIndex, member.test.id, skip)));
    return;
  }
  record.status = 'failed';
  members.forEach((member, memberIndex) => {
    record.members.push(
      memberIndex === 0
        ? memberFailedWith(record, 0, member.test.id, error, 'failed')
        : skippedMember(record.id, memberIndex, member.test.id, predecessorFailed(0)),
    );
  });
}

/** A member that failed with an error of its group attempt's, having run no step of its own. */
function memberFailedWith(
  record: SerialAttemptRecord,
  index: number,
  testId: string,
  error: SerializedError,
  status: 'failed' | 'timed-out',
): SerialMemberRecord {
  return {
    id: `${record.id}:member:${index}`,
    index,
    testId,
    status,
    startedAt: record.startedAt,
    durationMs: 0,
    steps: [],
    error,
    secondaryErrors: [],
  };
}

function isFailedMember(member: SerialMemberRecord): member is SerialMemberRecord & { status: FailedStatus } {
  return isFailedStatus(member.status);
}

/** Why a member the run's interrupt kept from running in this group attempt skipped. */
function interruptedMemberSkip(interruptSignal: AbortSignal): SkipInfo {
  return interruptedSkip(interruptSignal, {
    cause: 'infrastructure-unavailable',
    reason: 'run interrupted during this group attempt',
  });
}

function predecessorFailed(memberIndex: number): SkipInfo {
  return {
    cause: 'serial-predecessor-failed',
    reason: `member ${memberIndex} failed in this group attempt`,
  };
}

function skippedMember(
  attemptId: string,
  index: number,
  testId: string,
  skip: SkipInfo,
): SerialMemberRecord {
  return {
    id: `${attemptId}:member:${index}`,
    index,
    testId,
    status: 'skipped',
    startedAt: timestamp(),
    durationMs: 0,
    steps: [],
    skip,
    secondaryErrors: [],
  };
}

function serialTitlePath(test: CollectedTest): string[] {
  const titles = groupTitles(test.serialRoot);
  return titles.length === 0 ? [test.title] : titles;
}