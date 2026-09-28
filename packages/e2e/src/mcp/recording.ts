/**
 * Video recordings of a live session. A session does not record by itself:
 * the coding agent starts one when the part worth watching begins and stops
 * it when that part is over, as many times as it likes. Each recording is
 * the engine's video of the attempt between the two calls, moved out of the
 * attempt directory into `.e2e/videos/<session>/` as soon as it stops,
 * so the next one never overwrites it and closing the session never takes
 * it along. Recordings are not masked: they are files for a person to
 * watch, never pixels handed to the model, so the pixel taint that withholds
 * a screenshot does not withhold them; a recording stopped once the session
 * is tainted says so instead.
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { OperationContext, VideoSegment } from '../engine/surface.ts';

export interface SessionRecorderOptions {
  /** The engine's video hooks. */
  readonly startVideo: (operation: OperationContext) => Promise<void>;
  readonly stopVideo: (operation: OperationContext) => Promise<readonly VideoSegment[]>;
  /** The attempt's artifact directory, where the engine writes each segment. */
  readonly attemptDir: string;
  /** Where finished recordings land. */
  readonly outDir: string;
  /** An operation context for one engine call, bounded by `timeoutMs`. */
  readonly operation: (timeoutMs: number) => OperationContext;
  /** How long starting or stopping a recording may take. */
  readonly timeoutMs: number;
  /** True once a secret was filled in the session. */
  readonly tainted: () => boolean;
}

/** A recording that stopped: its files in order, and how long it ran. */
export interface FinishedRecording {
  readonly index: number;
  readonly name: string | undefined;
  /** Absolute paths, in the order they play; several when the surface replaced its page mid-recording. */
  readonly files: readonly string[];
  readonly startedAt: string;
  readonly durationMs: number;
  /** A secret was filled in the session by the time it stopped, so the video may show one. */
  readonly tainted: boolean;
}

interface ActiveRecording {
  readonly index: number;
  readonly name: string | undefined;
  readonly startedAt: Date;
  /** Set once the engine stopped it: what it wrote, still to be moved. */
  stopped?: { readonly segments: readonly VideoSegment[]; readonly at: number };
}

/**
 * Starts and stops the session's recordings, one at a time. Every call waits
 * for the one before it, so a close that saves the recording never races a
 * start_recording or stop_recording still in flight.
 */
export class SessionRecorder {
  private active: ActiveRecording | undefined;
  private count = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SessionRecorderOptions) {}

  /** True while a recording runs, or stopped but not yet saved. */
  get isRecording(): boolean {
    return this.active !== undefined;
  }

  /** Starts a recording; a recording already running is reported, not restarted. */
  start(name: string | undefined): Promise<string> {
    return this.serial(async () => {
      if (this.active !== undefined) {
        return `${describe(this.active)} is already running since ${this.active.startedAt.toISOString()}; stop_recording ends it.`;
      }
      try {
        await this.options.startVideo(this.options.operation(this.options.timeoutMs));
      } catch (cause) {
        // An engine may count a start that failed as a recording; stopping it
        // lets the next start_recording begin from nothing.
        await this.options.stopVideo(this.options.operation(this.options.timeoutMs)).catch(() => undefined);
        throw cause;
      }
      this.count += 1;
      this.active = { index: this.count, name, startedAt: new Date() };
      return `${describe(this.active)} started. Act as usual; stop_recording saves the video, and close_session saves one still running.`;
    });
  }

  /**
   * Stops the running recording and moves its files out of the attempt
   * directory; `undefined` when nothing records. A stop or a move that fails
   * leaves the recording in place, so stop_recording or close_session can
   * try again: the engine is asked to stop only once, and a file already
   * moved stays where it went.
   */
  stop(): Promise<FinishedRecording | undefined> {
    return this.serial(async () => {
      const active = this.active;
      if (active === undefined) return undefined;
      if (active.stopped === undefined) {
        // Before the engine call: finalizing the file can take seconds and records nothing.
        const at = Date.now();
        active.stopped = { segments: await this.options.stopVideo(this.options.operation(this.options.timeoutMs)), at };
      }
      const { segments, at } = active.stopped;
      const files = segments.map((segment, position) => this.keep(active, segment, position));
      this.active = undefined;
      const startedAt = segments[0]?.startedAt ?? active.startedAt.toISOString();
      return {
        index: active.index,
        name: active.name,
        files,
        startedAt,
        durationMs: Math.max(0, at - Date.parse(startedAt)),
        tainted: this.options.tainted(),
      };
    });
  }

  /** Runs `body` after every call before it has settled. */
  private serial<T>(body: () => Promise<T>): Promise<T> {
    const run = this.queue.then(body, body);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Moves one segment to `<outDir>/<index>[-<name>][-part<n>]<ext>`, unless an earlier try did, and returns where it landed. */
  private keep(recording: ActiveRecording, segment: VideoSegment, position: number): string {
    const stem = [String(recording.index), recording.name, position === 0 ? undefined : `part${String(position + 1)}`]
      .filter((part) => part !== undefined)
      .join('-');
    const destination = path.join(this.options.outDir, `${stem}${path.extname(segment.path)}`);
    const source = path.join(this.options.attemptDir, segment.path);
    if (!existsSync(source) && existsSync(destination)) return destination;
    mkdirSync(this.options.outDir, { recursive: true });
    renameSync(source, destination);
    return destination;
  }
}

/** Renders a stopped recording for the agent. */
export function describeRecording(recording: FinishedRecording): string {
  const seconds = (recording.durationMs / 1000).toFixed(1);
  const lines = [`${describe(recording)} stopped after ${seconds} s.`];
  if (recording.files.length === 0) {
    lines.push('The engine wrote no video: nothing was shown while it ran.');
  } else if (recording.files.length > 1) {
    lines.push(`${String(recording.files.length)} files, one per page the surface showed; they play in this order:`);
  }
  for (const file of recording.files) lines.push(`- ${file}`);
  if (recording.tainted && recording.files.length > 0) {
    lines.push('A secret was filled in this session and videos are not masked: check it is not on screen before sharing.');
  }
  return lines.join('\n');
}

function describe(recording: { readonly index: number; readonly name: string | undefined }): string {
  return `Recording ${String(recording.index)}${recording.name === undefined ? '' : ` "${recording.name}"`}`;
}

/** The session's `start_recording` and `stop_recording` tools. */
export function recordingTools(recorder: SessionRecorder): ToolSet {
  return {
    start_recording: {
      description:
        'Start recording a video of the app, for a person to watch: a demo for a pull request, or evidence of a bug. Everything on screen until stop_recording is in it, unmasked. One recording at a time; start and stop as many as you need.',
      inputSchema: z.object({
        name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, "-", and "_" only')
          .max(64)
          .optional()
          .describe('Short name for the file, e.g. "checkout-flow"'),
      }).strict(),
      execute: async (args: { name?: string | undefined }) => recorder.start(args.name),
    },
    stop_recording: {
      description:
        'Stop the running recording and save it: returns the absolute path of each video file, ready to attach to a pull request.',
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const recording = await recorder.stop();
        return recording === undefined ? 'Nothing is recording; start_recording starts a recording.' : describeRecording(recording);
      },
    },
  };
}
