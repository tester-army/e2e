/** Serial-group execution: one shared session per group attempt (spec 11-lifecycle.md). */

import { Ledger } from '../agent/ledger.ts';
import type { DriverSession } from '../driver/index.ts';
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
import { createAttemptArtifacts, sanitizePathSegment } from './artifacts.ts';
import type { AttemptContext } from './execute.ts';
import type { ArtifactSink } from './fixtures.ts';
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
import { pairResult } from './units.ts';

/**
 * One shared driver session plus its app open-state for a serial-group
 * attempt: members preserve app state, so a page opened by an earlier member
 * stays open for later members.
 */
export interface SharedSerialSession {
  readonly session: DriverSession;
  /**
   * Report segments of the group attempt directory. The shared session writes
   * every artifact there, so members resolve artifact paths against it rather
   * than against their own attempt directory.
   */
  readonly artifactSegments: readonly string[];
  readonly opened: { value: boolean };
  /** One ledger is shared so members see each other's prior steps. */
  readonly ledger: Ledger;
}

/** Executor capabilities the serial runner borrows. */
export interface SerialHost {
  readonly target: ResolvedTarget;
  readonly artifactsRoot: string;
  readonly interruptSignal: AbortSignal;
  readonly realms: RealmManager;
  readonly maxLedgerBytes: number;
  launchSession(
    pair: TestTargetPair,
    attemptId: string,
    artifactsDir: string,
    signal: AbortSignal,
  ): Promise<DriverSession>;
  closeSession(
    session: DriverSession,
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
      return attempt;
    },
  );

  if (group.attempts.length === 0) {
    group.status = 'skipped';
    group.skip = { cause: 'infrastructure-unavailable', reason: 'run interrupted before execution' };
  } else {
    group.status = finalStatus;
  }

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
      session: await host.launchSession(first, attemptId, artifacts.dir, host.interruptSignal),
      artifactSegments,
      opened: { value: false },
      ledger: new Ledger(host.maxLedgerBytes),
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
    const memberAttempt = await host.runAttempt(member, registered, realm, attemptIndex, {
      kind: 'serial',
      shared,
    });
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
  }
  await host.realms.leave(realm);
  await host.closeSession(shared.session, attemptId, record, artifacts.sink, record.secondaryErrors);

  const failedMember = memberRecords.find(isFailedMember);
  if (host.interruptSignal.aborted) {
    record.status = 'interrupted';
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