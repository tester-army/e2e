/** Serial-group execution: one shared session per group attempt (spec 11-lifecycle.md). */

import type { DriverSession } from '../driver/index.js';
import {
  classifyError,
  ConfigurationError,
  serializeError,
  type SerializedError,
} from '../internal/errors.js';
import { canonicalDigest, timestamp, uuidv7 } from '../internal/ids.js';
import type { CollectedFile, CollectedTest } from '../collect/collect.js';
import type { SkipInfo, TestTargetPair } from '../collect/select.js';
import type { ResolvedTarget } from '../config/resolve.js';
import { createAttemptArtifacts, sanitizePathSegment } from './artifacts.js';
import type { ArtifactSink } from './fixtures.js';
import { findRegistered, type Realm, RealmManager } from './realm.js';
import type {
  AttemptRecord,
  ResultRecord,
  ResultStatus,
  SerialAttemptRecord,
  SerialGroupRecord,
  SerialMemberRecord,
} from './records.js';
import type { RegisteredTest } from '../collect/registry.js';

/**
 * One shared driver session plus its app open-state for a serial-group
 * attempt: members preserve app state, so a page opened by an earlier member
 * stays open for later members.
 */
export interface SharedSerialSession {
  readonly session: DriverSession;
  readonly opened: { value: boolean };
}

/** Executor capabilities the serial runner borrows. */
export interface SerialHost {
  readonly target: ResolvedTarget;
  readonly artifactsRoot: string;
  readonly interruptSignal: AbortSignal;
  readonly realms: RealmManager;
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
    shared: SharedSerialSession,
  ): Promise<AttemptRecord>;
  emit(result: ResultRecord): void;
}

/** Runs one serial unit to completion and emits every member result. */
export async function runSerialUnit(
  host: SerialHost,
  members: readonly TestTargetPair[],
  file: CollectedFile,
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

  const maxAttempts = first.options.retries + 1;
  const memberFinalStatus = new Map<string, SerialMemberRecord>();

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    if (host.interruptSignal.aborted) break;
    const attempt = await runSerialAttempt(host, members, file, attemptIndex);
    group.attempts.push(attempt);
    for (const member of attempt.members) memberFinalStatus.set(member.testId, member);
    if (attempt.status === 'passed') break;
    if (attempt.status === 'interrupted') break;
  }

  const lastAttempt = group.attempts[group.attempts.length - 1];
  if (lastAttempt === undefined) {
    group.status = 'skipped';
    group.skip = { cause: 'infrastructure-unavailable', reason: 'run interrupted before execution' };
  } else if (lastAttempt.status === 'passed') {
    group.status = group.attempts.length > 1 ? 'flaky' : 'passed';
  } else {
    group.status = lastAttempt.status;
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
    host.emit({
      test: member.test,
      target: member.target,
      status,
      selected: true,
      ...(skip !== undefined ? { skip } : {}),
      attempts: [],
      serialGroupId: groupRecordId,
    });
  }

  return group;
}

async function runSerialAttempt(
  host: SerialHost,
  members: readonly TestTargetPair[],
  file: CollectedFile,
  attemptIndex: number,
): Promise<SerialAttemptRecord> {
  const attemptId = uuidv7();
  const startedAt = timestamp();
  const startedMs = Date.now();
  const memberRecords: SerialMemberRecord[] = [];
  const first = members[0]!;
  const artifacts = createAttemptArtifacts({
    artifactsRoot: host.artifactsRoot,
    segments: [
      host.target.name,
      sanitizePathSegment(first.test.serialId ?? first.test.id),
      `attempt-${attemptIndex}`,
    ],
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
    realm = await host.realms.create(file);
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
      opened: { value: false },
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

  let failedIndex = -1;
  for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
    const member = members[memberIndex]!;
    const memberId = `${attemptId}:member:${memberIndex}`;
    if (failedIndex >= 0 || host.interruptSignal.aborted) {
      memberRecords.push(
        skippedMember(attemptId, memberIndex, member.test.id, {
          cause: 'serial-predecessor-failed',
          reason: `member ${failedIndex} failed in this group attempt`,
        }),
      );
      continue;
    }
    const registered = findRegistered(realm, member.test);
    if (registered === undefined) {
      failedIndex = memberIndex;
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
      continue;
    }
    const memberAttempt = await host.runAttempt(member, registered, realm, attemptIndex, shared);
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
    if (memberAttempt.status !== 'passed') failedIndex = memberIndex;
  }
  await host.realms.leave(realm);
  await host.closeSession(shared.session, attemptId, record, artifacts.sink, record.secondaryErrors);

  const failedMember = memberRecords.find(
    (member) => member.status !== 'passed' && member.status !== 'skipped',
  );
  if (host.interruptSignal.aborted) {
    record.status = 'interrupted';
  } else if (failedMember === undefined) {
    record.status = 'passed';
  } else {
    record.status = failedMember.status as SerialAttemptRecord['status'];
    if (failedMember.error !== undefined) record.error = failedMember.error;
  }
  record.durationMs = Date.now() - startedMs;
  return record;
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
  const titles: string[] = [];
  for (let node = test.serialRoot; node !== undefined; node = node.parent) titles.unshift(node.title);
  return titles.length === 0 ? [test.title] : titles;
}
