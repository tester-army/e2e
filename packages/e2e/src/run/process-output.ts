/**
 * What user code in an `e2e run` process prints outside a test body: the
 * config's top-level code, a test file's top level while it is collected,
 * test filters, and reporters in the runner; the config's top-level code
 * again in each worker. It is redacted with every secret value the process
 * knows, as a test's output is. Until a config has loaded its secrets are
 * unknown, so what is printed meanwhile is held, and withheld if the load
 * fails.
 */

import { StreamRedactor, type SecretLedger } from '../internal/redact.ts';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { realmSlot } from '../internal/realm-slot.ts';
import type { ListReporterOutput } from '../report/list.ts';

export type OutputStream = 'stdout' | 'stderr';

/** Writes text to one stream of the terminal; the callback fires once the stream took it. Answers false while the stream is backed up, like `Writable.write`. */
export type TerminalWrite = (text: string, callback?: () => void) => boolean;

const BYTE_ENCODINGS: ReadonlySet<BufferEncoding> = new Set(['hex', 'base64', 'base64url']);

interface OutputRouting {
  readonly scope: AsyncLocalStorage<RunnerOutput | null>;
  readonly terminal: Record<OutputStream, TerminalWrite>;
  readonly dispatchers: Partial<Record<OutputStream, typeof process.stdout.write>>;
  process: RunnerOutput | undefined;
}

const routingSlot = realmSlot<OutputRouting>('e2e.process-output.routing.v1');

/** One process dispatcher preserves redaction for asynchronous work that outlives a suite. */
function routing(): OutputRouting {
  const streams = { stdout: process.stdout, stderr: process.stderr } as const;
  let state = routingSlot.get(process);
  if (state === undefined) {
    state = {
      scope: new AsyncLocalStorage(),
      terminal: {
        stdout: streams.stdout.write.bind(streams.stdout) as TerminalWrite,
        stderr: streams.stderr.write.bind(streams.stderr) as TerminalWrite,
      },
      dispatchers: {},
      process: undefined,
    };
    routingSlot.set(process, state);
  }
  for (const name of ['stdout', 'stderr'] as const) {
    if (streams[name].write === state.dispatchers[name]) continue;
    const forward = streams[name].write.bind(streams[name]) as (chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => boolean;
    state.terminal[name] = (text, callback) => {
      const done = callback === undefined ? undefined : AsyncResource.bind(callback);
      return state.scope.run(null, () => forward(text, done));
    };
    const dispatch = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean => {
      const context = state.scope.getStore();
      const output = context === null ? undefined : context ?? state.process;
      if (output === undefined) return forward(chunk, encoding, callback);
      const done = typeof encoding === 'function' ? encoding : callback;
      const bytes = typeof chunk === 'string' && typeof encoding === 'string' && BYTE_ENCODINGS.has(encoding);
      return output.write(name, bytes ? Buffer.from(chunk, encoding) : chunk, done);
    }) as typeof process.stdout.write;
    state.dispatchers[name] = dispatch;
    streams[name].write = dispatch;
  }
  return state;
}

/** The CLI owns every process write, including timers that print after a run ends. */
export function claimProcessOutput(ledger: SecretLedger): RunnerOutput {
  const state = routing();
  state.process ??= new RunnerOutput(state.terminal, ledger);
  return state.process;
}

/** Embedded runs own their async output; caller output resumes once cleanup ends. */
export async function withProcessOutput<T>(ledger: SecretLedger, run: (output: RunnerOutput) => Promise<T>): Promise<T> {
  const state = routing();
  const output = new RunnerOutput(state.terminal, ledger);
  try {
    return await state.scope.run(output, () => run(output));
  } finally {
    output.end();
  }
}

/**
 * Writes a reporter's own document straight to the terminal's `stream`, past
 * the routing of user output: `--reporter json` keeps stdout for its report
 * while what user code prints moves to stderr.
 */
export function writeTerminal(stream: OutputStream, text: string): void {
  const terminal = routingSlot.get(process)?.terminal;
  if (terminal === undefined) process[stream].write(text);
  else terminal[stream](text);
}

/** Where runner output goes instead of the terminal while the list reporter shows the run. */
export interface OutputView {
  /** Prints redacted text from `stream`. */
  show(stream: OutputStream, text: string): void;
  /** Prints what `show` left unfinished; nothing more follows. */
  end(): void;
}

/** The warning that stands in for what a config printed before it failed to load. */
function withheldWarning(bytes: number): string {
  return `withheld ${bytes} bytes of output printed while the config failed to load: its secrets are unknown, so the output cannot be redacted`;
}

/**
 * Holds what is written while a config loads. Released once the load
 * registered the config's secrets; dropped for a warning when it failed.
 */
export class ConfigLoadHold {
  private held: { readonly stream: OutputStream; readonly chunk: string | Uint8Array }[] | undefined;

  /** Holds `chunk` if a load is in flight; answers whether it did. */
  hold(stream: OutputStream, chunk: string | Uint8Array): boolean {
    if (this.held === undefined) return false;
    // A copy: the writer may reuse its buffer once the write returns.
    this.held.push({ stream, chunk: typeof chunk === 'string' ? chunk : Buffer.from(chunk) });
    return true;
  }

  /**
   * Runs `load`, which loads a config and registers its secrets, holding
   * what is written meanwhile. Then hands each held write to `release` in
   * order, or, if `load` threw, `warn`s with how much was withheld.
   */
  async during<T>(
    load: () => Promise<T>,
    release: (stream: OutputStream, chunk: string | Uint8Array) => void,
    warn: (line: string) => void,
  ): Promise<T> {
    this.held = [];
    let loaded = false;
    try {
      const value = await load();
      loaded = true;
      return value;
    } finally {
      const held = this.held;
      this.held = undefined;
      if (loaded) {
        for (const { stream, chunk } of held) release(stream, chunk);
      } else {
        const bytes = held.reduce((total, { chunk }) => total + Buffer.byteLength(chunk), 0);
        if (bytes > 0) warn(withheldWarning(bytes));
      }
    }
  }
}

/**
 * The runner process's user output, on its way to the terminal or, while
 * the list reporter shows it, through the reporter, which prints it above
 * its live window instead of letting it land inside.
 */
export class RunnerOutput {
  /** Each stream redacted on its own, across writes: a value split over two writes is still caught. */
  private readonly redactors: Readonly<Record<OutputStream, StreamRedactor>>;
  private readonly loadHold = new ConfigLoadHold();
  private view: OutputView | undefined;
  /** The terminal stream user stdout lands on: stderr once a reporter keeps stdout for its document. */
  private stdoutTo: OutputStream = 'stdout';
  /** The terminal's stdout for the list reporter: its own lines and live window go straight there. */
  readonly listOutput: Required<ListReporterOutput>;

  constructor(
    private readonly terminal: Readonly<Record<OutputStream, TerminalWrite>>,
    ledger: SecretLedger,
  ) {
    this.redactors = { stdout: new StreamRedactor(ledger), stderr: new StreamRedactor(ledger) };
    this.listOutput = {
      write: (line) => void terminal.stdout(`${line}\n`),
      raw: (text) => void terminal.stdout(text),
    };
  }

  /**
   * One write of user code to `stream`, redacted: the tail a later write
   * could complete into a value waits for it, or for `end`. Held while a
   * config loads. Answers what the terminal did.
   */
  write(stream: OutputStream, chunk: string | Uint8Array, callback?: () => void): boolean {
    if (this.loadHold.hold(stream, chunk)) {
      if (callback !== undefined) process.nextTick(callback);
      return true;
    }
    return this.emit(stream, this.redactors[stream].push(chunk), callback);
  }

  /**
   * Runs `load`, a config load that registers the config's secrets, holding
   * what is printed until it ends: the config's top-level code may print a
   * value before the process knows it is one. Released redacted once it
   * loaded; withheld with a warning when it failed.
   */
  withholdDuring<T>(load: () => Promise<T>): Promise<T> {
    return this.loadHold.during(
      load,
      (stream, chunk) => this.write(stream, chunk),
      (line) => this.emit('stderr', `e2e: [warning] ${line}\n`),
    );
  }

  /**
   * Passes what is printed to `view` from now on, or to the terminal again
   * when undefined. What the previous view was given is released to it
   * first, unfinished lines included, and that view ended.
   */
  showThrough(view: OutputView | undefined): void {
    if (this.view !== undefined) {
      this.release();
      this.view.end();
    }
    this.view = view;
  }

  /** Prints what user code writes to stdout on stderr from now on: a reporter prints a document on stdout (`--reporter json`). */
  keepStdoutForReport(): void {
    this.stdoutTo = 'stderr';
  }

  /** Prints a test's output, which its worker already redacted, to the terminal or the view. */
  testOutput(stream: OutputStream, text: string): void {
    this.emit(stream, text);
  }

  /** Releases what is still held, redacted, to the terminal. Later writes stay redacted; only a tail a later write could complete into a value is held. */
  end(): void {
    this.showThrough(undefined);
    this.release();
  }

  /**
   * Ends the output as `end` does, then resolves once the terminal's streams
   * wrote everything handed to them: what a process waits for before
   * `process.exit`, which drops what a piped stream still queues. A `write`
   * through the claimed stream would not wait: its callback fires once the
   * text is redacted.
   */
  async drain(): Promise<void> {
    this.end();
    await Promise.all((['stdout', 'stderr'] as const).map((stream) => new Promise<void>((resolve) => void this.terminal[stream]('', resolve))));
  }

  private release(): void {
    this.emit('stdout', this.redactors.stdout.flush());
    this.emit('stderr', this.redactors.stderr.flush());
  }

  private emit(stream: OutputStream, text: string, callback?: () => void): boolean {
    if (text === '' || this.view !== undefined) {
      if (text !== '') this.view?.show(stream, text);
      if (callback !== undefined) process.nextTick(callback);
      return true;
    }
    return this.terminal[stream === 'stdout' ? this.stdoutTo : stream](text, callback);
  }
}
