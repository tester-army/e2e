/**
 * `e2e run --step` without a terminal, for a coding agent or a script. The
 * run goes on in a process of its own, and later commands from the same
 * directory drive it: `e2e run --step next`, `rest`, and `stop`. Each command
 * returns once the run holds its next step or ends, with what the run printed
 * since the last command, how each step that ran since then ended, and the
 * held step with the screen it waits on, or a line saying the run has ended.
 *
 * The background run listens on a Unix socket (a named pipe on Windows) in a
 * directory only this user can open, keyed by the working directory, so one
 * directory has one stepped run at a time.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import picocolors from 'picocolors';
import { z } from 'zod';
import { classifyError, codedMessage, ConfigurationError, exitCodeForCategory } from '../internal/errors.ts';
import { stepLine, stepPromptText } from '../report/list-steps.ts';
import type { RunEventSink } from '../run/events.ts';
import { run, type RunOptions, type RunOutcome } from '../run/runner.ts';
import type { BeforeStep, StepPrompt } from '../run/step-hold.ts';
import type { SignalLadder } from './signals.ts';
import { STEP_ACTIONS, StepGate, type StepAction } from './step.ts';

/**
 * What a command sends, and what the background run answers: the text the
 * command prints and the exit code it ends with. The starting command names
 * its run's log, so it never drives a run another command started.
 */
const StepRequest = z.object({ action: z.enum(STEP_ACTIONS), log: z.string().optional() });
const StepReply = z.object({ text: z.string(), exitCode: z.number() });
type StepReply = z.infer<typeof StepReply>;

/** Where a stepped run listens, the lock it holds while it claims that, and the file its output goes to (one per starting command). */
export interface StepAddress {
  readonly socket: string;
  readonly lock: string;
  readonly log: string;
}

/** How long a stepped run holds a step with no command acting on it before it stops, and keeps its end for a command after it ended with none waiting. */
const IDLE_STOP_MS = 30 * 60_000;
/** How long an answer waits for more steps of the same `Promise.all` to be held beside the first. */
const JOIN_MS = 100;
/** A claim lock older than this was left by a run killed while it claimed, which takes milliseconds. */
const STALE_LOCK_MS = 10_000;
/** How often the starting command looks for the background run's socket while it boots. */
const CONNECT_POLL_MS = 100;
/** How long the run waits, once it has ended, for its last answers to reach their commands. */
const FLUSH_MS = 5_000;
/** The last line of the answer to a command the run ended on, so a reader knows no command is left to send. */
const ENDED = 'The stepped run has ended.\n';
/** Why a second start is refused; a word that is not an action reads as a file and lands here too. */
const ALREADY_GOING = 'a stepped run is already going in this directory: drive it with e2e run --step next, rest, or stop';

/**
 * Where the stepped run started from `cwd` listens and logs. The directory
 * holding them is created for this user alone, and refused when someone else
 * owns it or can read it: the socket drives the run and the log holds its output.
 */
export function stepAddress(cwd: string): StepAddress {
  const id = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  const uid = process.getuid?.();
  const dir = path.join(os.tmpdir(), uid === undefined ? 'e2e-step' : `e2e-step-${uid}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (uid !== undefined) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error(`${dir} must be a directory only you can open; remove it and run again`);
    }
  }
  return {
    socket: process.platform === 'win32' ? String.raw`\\.\pipe\e2e-step-` + id : path.join(dir, `${id}.sock`),
    lock: path.join(dir, `${id}.lock`),
    log: path.join(dir, `${id}-${process.pid}.log`),
  };
}

/** One JSON message `schema` reads, or undefined when the line is not one. */
function parseLine<T>(line: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/**
 * Sends one request and reads the answer. `absent` when nothing listens;
 * `closed` when the run hung up without answering.
 */
function ask(socket: string, request: z.infer<typeof StepRequest>): Promise<StepReply | 'absent' | 'closed'> {
  return new Promise((resolve) => {
    let received = '';
    let connected = false;
    const connection = net.connect(socket, () => {
      connected = true;
      connection.write(`${JSON.stringify(request)}\n`);
    });
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      received += chunk;
    });
    connection.on('error', () => undefined);
    connection.on('close', () => {
      if (!connected) {
        resolve('absent');
        return;
      }
      resolve(parseLine(received, StepReply) ?? 'closed');
    });
  });
}

/** Whether a stepped run listens on `socket`; connects and hangs up without asking anything. */
function listening(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(socket, () => {
      connection.end();
      resolve(true);
    });
    connection.on('error', () => resolve(false));
  });
}

/** Removes a socket file. Named pipes leave nothing behind. */
function removeSocket(socket: string): void {
  if (process.platform !== 'win32') fs.rmSync(socket, { force: true });
}

/** Reads what the log gained since `offset`. */
function readSince(file: string, offset: number): { readonly text: string; readonly offset: number } {
  try {
    const all = fs.readFileSync(file);
    return { text: all.subarray(offset).toString('utf8'), offset: Math.max(offset, all.length) };
  } catch {
    return { text: '', offset };
  }
}

/**
 * The starting command: spawns the stepped run in a process of its own and
 * returns once it holds its first step or ends. Throws when a stepped run
 * already listens for this directory.
 */
export async function startStepped(address: StepAddress, args: readonly string[]): Promise<number> {
  if (await listening(address.socket)) {
    throw new Error(ALREADY_GOING);
  }
  // Before a `--`, which ends the options.
  const end = args.includes('--') ? args.indexOf('--') : args.length;
  const serveArgs = [...args.slice(0, end), '--step-serve', address.log, ...args.slice(end)];
  const log = fs.openSync(address.log, 'w', 0o600);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...serveArgs], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  fs.closeSync(log);
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', () => resolve(2));
  });
  process.stdout.write('No terminal, so the run goes on in the background. Drive it from this directory with e2e run --step next, rest, or stop.\n');
  for (;;) {
    // `next` runs no step a command has not printed, so this waits for the first held one.
    const answer = await ask(address.socket, { action: 'next', log: address.log });
    if (typeof answer === 'object') {
      child.unref();
      process.stdout.write(answer.text);
      return answer.exitCode;
    }
    const code = await Promise.race([exited, sleep(CONNECT_POLL_MS)]);
    if (code !== undefined) {
      // It ended before anyone asked (a config that would not load), and kept its log: what it printed says why.
      process.stdout.write(readSince(address.log, 0).text + ENDED);
      fs.rmSync(address.log, { force: true });
      return code;
    }
  }
}

/** A later command: sends `action` to the stepped run for this directory and prints its answer. */
export async function sendStep(address: StepAddress, action: StepAction): Promise<number> {
  const answer = await ask(address.socket, { action });
  if (answer === 'absent') throw new Error('no stepped run is going in this directory: start one with e2e run <files> --step');
  if (answer === 'closed') throw new Error('the stepped run was killed before it answered');
  process.stdout.write(answer.text);
  return answer.exitCode;
}

/**
 * Listens on `address.socket`; a socket file a dead run left is removed, a
 * live run's is refused. The run holds `address.lock`, created exclusively,
 * while it claims, so two runs starting at once over a dead run's file cannot
 * both remove it and listen: the one without the lock is refused. A lock a
 * run killed mid-claim left is refused too, with its path to remove. Named pipes
 * go with their process, so a taken one is always live.
 */
async function claim(server: net.Server, address: StepAddress): Promise<void> {
  const busy = (cause: unknown): ConfigurationError =>
    new ConfigurationError('RUNNER_BUSY', ALREADY_GOING, { cause });
  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address.socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
  let held: number;
  try {
    held = fs.openSync(address.lock, 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    // Never removed here: two runs that both found it stale could both take it.
    const made = fs.statSync(address.lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
    if (Date.now() - made < STALE_LOCK_MS) throw busy(cause);
    throw new ConfigurationError('RUNNER_BUSY', `${address.lock} was left by a stepped run killed while it started; remove it and run again`, { cause });
  }
  try {
    await listen();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw cause;
    if (process.platform === 'win32' || (await listening(address.socket))) throw busy(cause);
    removeSocket(address.socket);
    await listen();
  } finally {
    fs.closeSync(held);
    fs.rmSync(address.lock, { force: true });
  }
}

/**
 * The background run: runs the tests with every later step held, and
 * answers commands on `address.socket`. A command applies its action, then
 * gets its answer when the run holds a step no command has printed yet, or
 * ends: `next` and `rest` act only on a held step a command has printed, so
 * one whose command was killed is printed first, never run unseen. Each
 * answer starts with what the run's output (`address.log`) gained since the
 * last. The process ends once the run has and a command got the end, so a
 * command killed by its shell's timeout loses nothing; a run that ends
 * before any command got an answer keeps its log for the starting command.
 */
export async function serveSteps(options: RunOptions, signals: SignalLadder, address: StepAddress): Promise<RunOutcome> {
  /** The held step no command has printed yet. */
  let unseen: StepPrompt | undefined;
  let stopping = false;
  let ended: StepReply | undefined;
  let printed = 0;
  /** Whether a command got an answer, so the starting command no longer reads the log. */
  let answered = false;
  /** Whether a step a command printed waits for `next` or `rest`. */
  let held = false;
  /** Each waiting command, with the note its answer opens with when its action was not applied. */
  const waiting = new Map<net.Socket, string>();
  /** Answers on their way out, which the run waits for before it ends: its exit does not wait for sockets. */
  const sent: Promise<unknown>[] = [];
  let joining: NodeJS.Timeout | undefined;
  let idle: NodeJS.Timeout | undefined;
  /** Called once a command got the end. */
  let endSent: (() => void) | undefined;

  /** Each call climbs the ladder a rung, as a second `q` forces a run whose teardown hangs. */
  const stop = (): void => {
    stopping = true;
    signals.escalate();
  };
  const gate = new StepGate(stop, { keyGuardMs: 0 });
  /** Answers every waiting command, once there is a step no command has printed, or the end. */
  const answer = (): void => {
    const reply = ended ?? (unseen !== undefined && !stopping ? { text: stepPromptText(unseen), exitCode: 0 } : undefined);
    if (reply === undefined || waiting.size === 0) return;
    unseen = undefined;
    answered = true;
    const since = readSince(address.log, printed);
    printed = since.offset;
    for (const [client, note] of waiting) {
      const line = `${JSON.stringify({ text: note + since.text + reply.text, exitCode: reply.exitCode } satisfies StepReply)}\n`;
      sent.push(new Promise((resolve) => client.once('close', resolve)));
      client.end(line);
    }
    waiting.clear();
    if (reply === ended) endSent?.();
  };
  /** Answers a moment later, so the steps of one `Promise.all` held one after another share the answer. */
  const answerSoon = (): void => {
    clearTimeout(joining);
    joining = setTimeout(answer, JOIN_MS);
  };
  /**
   * Applies one command's action, and returns the note its answer opens with
   * when the action was not applied. `next` and `rest` act only on a held
   * step a command has printed.
   */
  const apply = (action: StepAction, starting: boolean): string => {
    // The run is over; the command gets its end.
    if (ended !== undefined) return action === 'stop' ? '' : `e2e run --step ${action} was not applied: the run had ended.\n`;
    if (action === 'stop') stop();
    // The starting command waits for the first held step and presses nothing.
    else if (starting) return '';
    else if (unseen !== undefined) return `e2e run --step ${action} was not applied: the step below was held while no command waited, so it shows first.\n`;
    else if (!held) return `e2e run --step ${action} was not applied: it came while a step ran, so it waited for the next pause or the end; send it again to apply it.\n`;
    else gate.press(action === 'next' ? 'continue' : 'rest');
    return '';
  };
  /** A held step nobody acts on stops the run, so an abandoned one does not keep its app and browser. */
  const restartIdle = (): void => {
    clearTimeout(idle);
    if (held) idle = setTimeout(stop, IDLE_STOP_MS);
  };
  const handle = (client: net.Socket, { action, log }: z.infer<typeof StepRequest>): void => {
    // Another start's command, which waits for its own run to fail.
    if (log !== undefined && log !== address.log) {
      client.destroy();
      return;
    }
    waiting.set(client, apply(action, log !== undefined));
    restartIdle();
    client.on('close', () => waiting.delete(client));
    answerSoon();
  };

  const server = net.createServer((client) => {
    let received = '';
    client.setEncoding('utf8');
    client.on('error', () => undefined);
    const onData = (chunk: string): void => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end === -1) return;
      client.off('data', onData);
      const request = parseLine(received.slice(0, end), StepRequest);
      if (request === undefined) client.destroy();
      else handle(client, request);
    };
    client.on('data', onData);
  });
  await claim(server, address);

  const beforeStep: BeforeStep = (step, context) =>
    gate.beforeStep(step, {
      signal: context.signal,
      show: (shown) => {
        unseen = shown;
        held = shown !== undefined;
        restartIdle();
        answerSoon();
      },
    });
  const plain = picocolors.createColors(false);
  // Beside the list reporter's lines, not as the runner's own console output.
  const print = options.processOutput?.listOutput.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  /**
   * Prints how each step ended into the run's output, which the next answer
   * starts with, then passes the event on. Agent steps are left out: without
   * a terminal the list reporter prints those itself.
   */
  const onEvent: RunEventSink = (event) => {
    if (event.type === 'step' && event.progress.phase === 'end' && event.progress.kind !== 'agent') {
      const { error } = event.progress;
      print(stepLine(plain, event.progress));
      if (error !== undefined) print(`${error.code}: ${error.message}`.replace(/^/gm, '  '));
    }
    return options.onEvent?.(event);
  };
  try {
    const outcome = await run({ ...options, beforeStep, onEvent, heldScreens: true });
    ended = { text: ENDED, exitCode: outcome.exitCode };
    return outcome;
  } catch (cause) {
    ended = { text: `error: ${codedMessage(cause)}\n${ENDED}`, exitCode: exitCodeForCategory(classifyError(cause).category) };
    throw cause;
  } finally {
    clearTimeout(joining);
    clearTimeout(idle);
    const sending = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, IDLE_STOP_MS);
      endSent = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    answer();
    await sending;
    // Removes the socket file too, while this run still owns it.
    server.close();
    if (answered) fs.rmSync(address.log, { force: true });
    await Promise.race([Promise.all(sent), sleep(FLUSH_MS, undefined, { ref: false })]);
  }
}
