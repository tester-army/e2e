/**
 * How a client reaches an engine server: a child process over its stdio,
 * a TCP socket to a server running elsewhere, or a server in this process.
 * A transport only opens byte streams; the protocol is the same on all.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import type { EngineAppInfo, EngineHandle } from '../index.ts';
import type { MessageStreams } from './connection.ts';
import type { ConnectionRole } from './protocol.ts';
import { serveEngine } from './server.ts';

/** What a transport knows when it opens a connection. */
export interface TransportContext {
  /** The connection's role; see `InitializeParams.role`. */
  readonly role: ConnectionRole;
  /** The environment the harness would start a worker with. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The project root, where relative paths resolve. */
  readonly cwd: string;
  /**
   * The app the target declares, as `prepare` and `init` receive it: what a
   * transport that provisions a machine installs there (a build at
   * `appPath`, relative to `cwd`), since a server elsewhere cannot read the
   * project's files. Absent for a connection opened outside those hooks.
   */
  readonly app?: EngineAppInfo;
  /** Aborts when opening must stop; it never aborts once `open` has resolved. */
  readonly signal: AbortSignal;
}

/** One open connection's streams. */
export interface TransportConnection extends MessageStreams {
  /** Releases what the transport holds (a process, a socket), within `timeoutMs`. */
  close(timeoutMs: number): Promise<void>;
  /** What the transport saw go wrong (a server's last stderr lines), for an error message. */
  diagnostics?(): string;
}

/** Opens connections to an engine server. */
export interface EngineTransport {
  /** A short description for error messages: the command, or the address. */
  readonly label: string;
  open(context: TransportContext): Promise<TransportConnection>;
}

/** Options of `spawnTransport`. */
export interface SpawnTransportOptions {
  /** The server executable. */
  readonly command: string;
  readonly args?: readonly string[];
  /** Variables added to the worker's environment for the server. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory; defaults to the project root. */
  readonly cwd?: string;
}

/** Bytes of a server's stderr kept for the message of a failure. */
const STDERR_TAIL_BYTES = 4096;

/**
 * Starts the server as a child process per connection and speaks over its
 * stdin and stdout, the way an editor starts a language server. Its stderr
 * is kept for the message of a failure.
 */
export function spawnTransport(options: SpawnTransportOptions): EngineTransport {
  return {
    label: [options.command, ...(options.args ?? [])].join(' '),
    async open(context) {
      const child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd ?? context.cwd,
        env: { ...context.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });
      // `exit`, not `close`: a grandchild that inherited the pipes keeps
      // them open after the server is gone.
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return {
        input: child.stdout,
        output: child.stdin,
        diagnostics: () => {
          const tail = stderr.trim();
          const status = child.exitCode === null ? (child.signalCode === null ? '' : `killed by ${child.signalCode}`) : `exited with code ${child.exitCode}`;
          return [status, tail === '' ? '' : `stderr:\n${tail}`].filter((part) => part !== '').join('; ');
        },
        async close(timeoutMs) {
          child.stdin.end();
          if (child.exitCode !== null || child.signalCode !== null) return;
          const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(0, timeoutMs));
          child.kill('SIGTERM');
          await exited;
          clearTimeout(timer);
          child.stdout.destroy();
          child.stderr.destroy();
        },
      };
    },
  };
}

/** Options of `socketTransport`. */
export interface SocketTransportOptions {
  readonly host: string;
  readonly port: number;
}

/**
 * Connects to a server already listening on a TCP port: a server on another
 * machine, or one a launcher forwarded from a device. The server outlives
 * the connection; closing ends the socket only.
 */
export function socketTransport(options: SocketTransportOptions): EngineTransport {
  return {
    label: `${options.host}:${String(options.port)}`,
    async open(context) {
      const socket = connect({ host: options.host, port: options.port });
      socket.setNoDelay(true);
      await new Promise<void>((resolve, reject) => {
        const abandon = (): void => {
          socket.destroy();
          reject(context.signal.reason);
        };
        if (context.signal.aborted) abandon();
        context.signal.addEventListener('abort', abandon, { once: true });
        socket.once('connect', () => {
          context.signal.removeEventListener('abort', abandon);
          resolve();
        });
        socket.once('error', (cause) => {
          context.signal.removeEventListener('abort', abandon);
          reject(cause);
        });
      });
      return {
        input: socket,
        output: socket,
        async close() {
          socket.end();
          socket.destroy();
        },
      };
    },
  };
}

/**
 * Serves `engine` in this process over in-memory streams. Every call still
 * crosses the protocol, serialized as on any other transport, so a suite
 * run through it proves an engine and the harness need nothing the
 * protocol cannot carry.
 */
export function loopbackTransport(engine: EngineHandle): EngineTransport {
  return {
    label: `loopback ${engine.name}`,
    async open() {
      const toServer = new PassThrough();
      const toClient = new PassThrough();
      void serveEngine(engine, { input: toServer, output: toClient });
      return {
        input: toClient,
        output: toServer,
        async close() {
          toServer.end();
          toClient.end();
        },
      };
    },
  };
}
