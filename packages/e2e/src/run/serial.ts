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
import type { SkipInfo, TestTargetPair } from '../collect/select.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { ArtifactStore } from '../types.ts';
import { createAttemptArtifacts, sanitizePathSegment } from './artifacts.ts';
import type { AttemptContext } from './execute.ts';
import type { ArtifactSink } from './fixtures.ts';
import type { StepRecord } from './steps.ts';
import { findRegistered, type Realm, RealmManager } from './realm.ts';
import type {
  AttemptRecord,
  ResultRecord,
  ResultStatus,
  SerialAttemptRecord,
  SerialGroupRecord,
  SerialMemberRecord,
} from './records.ts';
import { runWithRetries } from './retry.ts';
import { INTERRUPTED_BEFORE_START, pairResult } from './units.ts';

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
  readonly runId: string;
  /** The configured artifact store, so group-owned artifacts (the shared trace) upload like any other. */
  readonly artifactStore: ArtifactStore | undefined;
  readonly interruptSignal: AbortSignal;
  readonly realms: RealmManager;
  launchSession(
    sessionName: string | undefined,
    attemptId: string,
    artifactsDir: string,
    signal: AbortSignal,
  ): Promise<TargetSession>;
  closeSession(
    session: TargetSession,
    attemptId: string,
    record: { cleanup: 'complete' | 'failed' | 'forced' },
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
}

/** Runs one serial unit to completion and emits every member result. */
export async function runSerialUnit(
  host: SerialHost,
  members: readonly TestTargetPair[],
  absolutePath: string,
): Promise<SerialGroupRecord> {
  const first = members[0]!;
  const serialId = first.test.serialId!;
  const groupRecordId = canonicalDigest({ serialId, targetId: host.target.name });

  const group: SerialGroupRecord = {
    id: groupRecordId,
    serialId,
    declarationIndex: first.test.declarationIndex,
    file: first.test.file,
    titlePath: serialTitlePath(first.test),
    targetId: host.target.name,
    platform: host.target.platform,
    memberTestIds: members.map((member) => member.test.id),
    status: 'failed',
    attempts: [],
  };

  const memberFinalStatus = new Map<string, SerialMemberRecord>();
  const finalStatus = await runWithRetries(
    first.options.retries + 1,
    host.interruptSignal,
    async (attemptIndex) => {
      const attempt = await runSerialAttempt(host, members, absolutePath, attemptIndex);
      group.attempts.push(attempt);
      for (const member of attempt.members) memberFinalStatus.set(member.testId, member);
      // A beforeAll failure is not retry-eligible: the
      // attempt stands as recorded and the retry loop stops here.
      if (attempt.error?.code === 'HOOK_FAILED') return undefined;
      return attempt;
    },
  );

  if (group.attempts.length === 0) {
    group.status = 'skipped';
    group.skip = INTERRUPTED_BEFORE_START;
  } else {
    group.status = finalStatus;
  }

  host.emitSerialGroup(group);
  for (const member of members) {
    const memberRecord = memberFinalStatus.get(member.test.id);
    let status: ResultStatus;
    let skip: SkipInfo | undefined;
    if (group.status === 'passed' || group.status === 'flaky') {
      status = group.status;
    } else if (memberRecord === undefined) {
      status = 'skipped';
      skip = { cause: 'serial-predecessor-failed', reason: 'group attempt did not reach this member' };
    } else if (memberRecord.status === 'skipped') {
      status = 'skipped';
      skip = memberRecord.skip;
    } else {
      status = memberRecord.status;
    }
    host.emit(
      pairResult(member, {
        status,
        selected: true,
        ...(skip !== undefined ? { skip } : {}),
        attempts: [],
        serialGroupId: groupRecordId,
      }),
    );
  }

  return group;
}

async function runSerialAttempt(
  host: SerialHost,
  members: readonly TestTargetPair[],
  absolutePath: string,
  attemptIndex: number,
): Promise<SerialAttemptRecord> {
  const attemptId = uuidv7();
  const startedAt = timestamp();
  const startedMs = Date.now();
  const memberRecords: SerialMemberRecord[] = [];
  const first = members[0]!;
  const artifactSegments = [
    host.target.name,
    sanitizePathSegment(first.test.serialId ?? first.test.id),
    `attempt-${attemptIndex}`,
  ];
  const artifacts = createAttemptArtifacts({
    artifactsRoot: host.artifactsRoot,
    segments: artifactSegments,
    attemptId,
    ...(host.artifactStore === undefined ? {} : { store: host.artifactStore }),
    // A group-owned artifact (the shared trace) is identified by the group,
    // the same identity its report path uses.
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
    cleanup: 'complete',
  };

  let realm: Realm;
  try {
    realm = await host.realms.create(absolutePath);
  } catch (cause) {
    record.status = 'failed';
    record.error = serializeError(classifyError(cause), { phase: 'collection' });
    record.durationMs = Date.now() - startedMs;
    return record;
  }

  let shared: SharedSerialSession;
  try {
    shared = {
      session: await host.launchSession(first.options.session, attemptId, artifacts.dir, host.interruptSignal),
      attemptId,
      artifactSegments,
      priorSteps: [],
      memory: new Map(),
    };
  } catch (cause) {
    const error = classifyError(cause);
    record.status = 'failed';
    record.error = serializeError(error, { phase: 'launch' });
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      memberRecords.push(
        skippedMember(attemptId, memberIndex, members[memberIndex]!.test.id, {
          cause: 'infrastructure-unavailable',
          reason: error.message,
        }),
      );
    }
    record.durationMs = Date.now() - startedMs;
    await host.realms.leave(realm);
    return record;
  }

  let skipRemaining: SkipInfo | undefined;
  let hookFailure: SerializedError | undefined;
  for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
    const member = members[memberIndex]!;
    const memberId = `${attemptId}:member:${memberIndex}`;
    if (skipRemaining === undefined && host.interruptSignal.aborted) {
      skipRemaining = {
        cause: 'infrastructure-unavailable',
        reason: 'run interrupted during this group attempt',
      };
    }
    if (skipRemaining !== undefined) {
      memberRecords.push(skippedMember(attemptId, memberIndex, member.test.id, skipRemaining));
      continue;
    }
    const registered = findRegistered(realm, member.test);
    if (registered === undefined) {
      memberRecords.push({
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
      memberRecords.push(skippedMember(attemptId, memberIndex, member.test.id, skipRemaining));
      continue;
    }
    host.pairStarted(member);
    const memberAttempt = await host.runAttempt(member, registered, realm, attemptIndex, {
      kind: 'serial',
      shared,
    });
    shared.priorSteps.push(...memberAttempt.steps);
    memberRecords.push({
      id: memberId,
      index: memberIndex,
      testId: member.test.id,
      status: memberAttempt.status,
      startedAt: memberAttempt.startedAt,
      durationMs: memberAttempt.durationMs,
      steps: memberAttempt.steps,
      ...(memberAttempt.error !== undefined ? { error: memberAttempt.error } : {}),
      secondaryErrors: memberAttempt.secondaryErrors,
    });
    record.artifacts.push(...memberAttempt.artifacts);
    if (memberAttempt.status !== 'passed') skipRemaining = predecessorFailed(memberIndex);
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
  await host.closeSession(shared.session, attemptId, record, artifacts.sink, record.secondaryErrors);
  await artifacts.settle();

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
  record.durationMs = Date.now() - startedMs;
  return record;
}

type FailedMemberStatus = Exclude<SerialMemberRecord['status'], 'passed' | 'skipped'>;

function isFailedMember(
  member: SerialMemberRecord,
): member is SerialMemberRecord & { status: FailedMemberStatus } {
  return member.status !== 'passed' && member.status !== 'skipped';
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