/**
 * What the `e2e mcp` process prints besides the protocol. User code runs in
 * this process (the config's top-level code, project tools, engines), and
 * what it writes to stdout or stderr reaches the operator's stderr redacted
 * with every secret value the process knows, as a test's output leaves an
 * `e2e run` worker. The server's own diagnostics are redacted where they are
 * written and pass as they are.
 */

import { StreamRedactor, type SecretLedger } from '../internal/redact.ts';

export type OutputStream = 'stdout' | 'stderr';

/** Writes text to the operator's stderr; the callback fires once the stream took it. Answers false while the stream is backed up, like `Writable.write`. */
export type OutputSink = (text: string, callback?: () => void) => boolean;

export class McpOutput {
  private readonly redactors: Readonly<Record<OutputStream, StreamRedactor>>;
  /** Config loads in flight: until each ends, what anyone prints is held. */
  private loading = 0;
  /** Whether a load in flight failed, so its secrets are unknown and what is held cannot be redacted. */
  private loadFailed = false;
  private held: { readonly stream: OutputStream; readonly chunk: string | Uint8Array }[] = [];
  /** Whether the last text passed on ended its line. */
  private atLineStart = true;

  constructor(
    private readonly sink: OutputSink,
    ledger: SecretLedger,
  ) {
    this.redactors = { stdout: new StreamRedactor(ledger), stderr: new StreamRedactor(ledger) };
  }

  /**
   * One write of user code to `stream`, redacted across writes: the tail a
   * later write could complete into a value waits for it, or for
   * `releaseTails`. Held while a config loads. Answers what the sink did.
   */
  write(stream: OutputStream, chunk: string | Uint8Array, callback?: () => void): boolean {
    if (this.loading > 0) {
      this.held.push({ stream, chunk });
      if (callback !== undefined) process.nextTick(callback);
      return true;
    }
    return this.emit(this.redactors[stream].push(chunk), callback);
  }

  /** One line of the server's own, already redacted where it was written; on a line of its own even when user code left one unfinished. */
  log(line: string): void {
    this.emit(`${this.atLineStart ? '' : '\n'}${line}\n`);
  }

  /**
   * Runs `load`, a config load that registers the config's secrets, holding
   * what anyone prints until it ends: the config's top-level code may print
   * a value before the process knows it is one. Released redacted once every
   * load in flight succeeded; withheld when one failed, since the secrets of
   * a config that did not load are unknown.
   */
  async withholdDuring<T>(load: () => Promise<T>): Promise<T> {
    this.loading += 1;
    try {
      return await load();
    } catch (cause) {
      this.loadFailed = true;
      throw cause;
    } finally {
      this.loading -= 1;
      if (this.loading === 0) this.releaseHeld();
    }
  }

  /**
   * Releases, redacted, the tails each stream holds for a later write to
   * complete, at the end of a tool call: user code that printed without a
   * newline is seen when its call ends, not when the server exits. Waits
   * while a config loads.
   */
  releaseTails(): void {
    if (this.loading > 0) return;
    for (const redactor of Object.values(this.redactors)) this.emit(redactor.flush());
  }

  /** Releases what each stream still holds, redacted; nothing more will follow. Output held for a load still in flight is withheld. */
  end(): void {
    if (this.loading > 0) this.withhold();
    for (const redactor of Object.values(this.redactors)) this.emit(redactor.flush());
  }

  private releaseHeld(): void {
    if (this.loadFailed) {
      this.withhold();
      return;
    }
    const held = this.held;
    this.held = [];
    for (const { stream, chunk } of held) this.emit(this.redactors[stream].push(chunk));
  }

  private withhold(): void {
    const bytes = this.held.reduce((total, { chunk }) => total + (typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength), 0);
    this.held = [];
    this.loadFailed = false;
    if (bytes > 0) this.log(`e2e mcp: [warning] withheld ${bytes} bytes of output printed while a config failed to load: its secrets are unknown, so the output cannot be redacted`);
  }

  private emit(text: string, callback?: () => void): boolean {
    if (text === '') {
      if (callback !== undefined) process.nextTick(callback);
      return true;
    }
    this.atLineStart = text.endsWith('\n');
    return this.sink(text, callback);
  }
}
