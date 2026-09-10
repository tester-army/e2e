/**
 * The committed record of one bench matrix: the aggregates the leaderboard
 * renders, a compact copy of every run (outcome per task, no transcripts),
 * and the provenance needed to compare rows later. Raw reports and traces
 * stay in `.bench/` as run artifacts; this file is the durable part.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregate, type ArmTrackAggregate } from './aggregate.ts';
import { REFERENCE_ARM, type Arm } from './catalog.ts';
import type { RunScore } from './score-run.ts';
import { TASK_SET_VERSION, type Track, type TrackId } from './tracks.ts';

const SUMMARY_SCHEMA = 'e2e-bench-summary-1';

export interface Provenance {
  readonly e2eVersion: string;
  readonly commit: string;
  readonly node: string;
  readonly platform: string;
}

export interface CompactRun {
  readonly arm: string;
  readonly track: TrackId;
  readonly repeat: number;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly runStatus?: string;
  readonly tasks: readonly { readonly id: string; readonly status: string; readonly code?: string }[];
  readonly explore?: {
    readonly ended: string;
    readonly found: readonly string[];
    readonly validUnplanted: readonly string[];
    readonly falsePositives: readonly string[];
    readonly other: readonly string[];
  };
  readonly usage: RunScore['usage'];
}

export interface Summary {
  readonly schema: typeof SUMMARY_SCHEMA;
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly taskSetVersion: number;
  readonly provenance: Provenance;
  readonly config: {
    readonly arms: readonly Pick<Arm, 'id' | 'model' | 'tier' | 'pricing' | 'providerOptions'>[];
    readonly tracks: readonly TrackId[];
    readonly repeats: number;
    /** The arm the harness time series holds fixed across releases. */
    readonly referenceArm: string;
  };
  readonly rows: readonly ArmTrackAggregate[];
  readonly runs: readonly CompactRun[];
}

/** Reads the e2e version and the commit the bench ran on; `unknown` where a value cannot be read. */
export function collectProvenance(root: string): Provenance {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    // Not a checkout (a tarball, a CI export without history): the version still identifies the harness.
  }
  const pkg = JSON.parse(readFileSync(path.join(root, 'packages/e2e/package.json'), 'utf8')) as { version: string };
  return { e2eVersion: pkg.version, commit, node: process.version, platform: `${os.platform()}-${os.arch()}` };
}

export function buildSummary(options: {
  readonly label: string;
  readonly createdAt: string;
  readonly provenance: Provenance;
  readonly arms: readonly Arm[];
  readonly tracks: readonly Track[];
  readonly repeats: number;
  readonly scores: readonly RunScore[];
}): Summary {
  return {
    schema: SUMMARY_SCHEMA,
    id: `${options.createdAt.slice(0, 10)}-${options.label}`,
    label: options.label,
    createdAt: options.createdAt,
    taskSetVersion: TASK_SET_VERSION,
    provenance: options.provenance,
    config: {
      arms: options.arms.map((arm) => ({
        id: arm.id,
        model: arm.model,
        tier: arm.tier,
        pricing: arm.pricing,
        ...(arm.providerOptions === undefined ? {} : { providerOptions: arm.providerOptions }),
      })),
      tracks: options.tracks.map((track) => track.id),
      repeats: options.repeats,
      referenceArm: REFERENCE_ARM,
    },
    rows: aggregate(options.scores),
    runs: options.scores.map(compact),
  };
}

function compact(score: RunScore): CompactRun {
  return {
    arm: score.arm,
    track: score.track,
    repeat: score.repeat,
    exitCode: score.process.exitCode,
    durationMs: score.process.durationMs,
    ...(score.process.error === undefined ? {} : { error: score.process.error }),
    ...(score.runStatus === undefined ? {} : { runStatus: score.runStatus }),
    tasks: score.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      ...(task.code === undefined ? {} : { code: task.code }),
    })),
    ...(score.explore === undefined
      ? {}
      : {
          explore: {
            ended: score.explore.ended,
            found: score.explore.found,
            validUnplanted: score.explore.validUnplanted,
            falsePositives: score.explore.falsePositives,
            other: score.explore.other,
          },
        }),
    usage: score.usage,
  };
}

/** Writes `<dir>/<id>.json` and returns the path. */
export function writeSummary(dir: string, summary: Summary): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${summary.id}.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  return file;
}

/** The newest summary in `dir` by id (ids start with the date), or undefined when there is none. */
export function latestSummary(dir: string): string | undefined {
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).toSorted();
  const last = files.at(-1);
  return last === undefined ? undefined : path.join(dir, last);
}

export function readSummary(file: string): Summary {
  return JSON.parse(readFileSync(file, 'utf8')) as Summary;
}
