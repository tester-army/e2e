/**
 * The services a target lists: what `defineService` takes, what its handle
 * is, and what a function service's `start` and `stop` receive. Re-exported
 * from `e2e` through `types.ts`.
 */

import type { serviceBrand } from '../internal/brands.ts';
import type { CommandConfig } from '../types.ts';

/** What every service declares, whichever form it takes. */
interface ServiceBase {
  /**
   * The service's name in errors, reporter output, and placeholders: ASCII
   * letters, digits, `_`, and `-`, at most 64 characters. One name is one
   * service across the run; two handles with the same name are
   * `INVALID_CONFIG`.
   */
  name: string;
  /**
   * Services that must be ready before this one starts, and stop after it.
   * A target that lists this service gets them too, whether it lists them or
   * not. Each is a handle defined before this one, and the list is copied
   * when the service is defined, so services never depend on each other in a
   * cycle.
   */
  dependsOn?: readonly ServiceHandle[];
}

/**
 * A service the runner spawns (a database container, an API mock, a dev
 * server): a command with exactly one readiness contract, `readyUrl` or
 * `waitForExit: true`.
 */
export interface ProcessServiceOptions extends ServiceBase, CommandConfig {
  /**
   * HTTP readiness probe, a status of 200 through 499 counts as ready. It is
   * also the service's primary address (`svc.url`, `svc.port`). Port 0 on a
   * loopback address (`http://127.0.0.1:0`) asks the run for a free port,
   * which `{port}` names in the service's args, env, and teardown; on a
   * fixed port `{port}` is `INVALID_CONFIG` (write the port). It may name a
   * port of `ports` as `{port:name}`, but not another service's address: it
   * is this service's own.
   */
  readyUrl?: string;
  /**
   * Wait for the process to exit with code 0 instead of probing a URL
   * (migrations, `docker compose up --wait`). A non-zero exit or the
   * `startupTimeout` expiring is `APP_UNREACHABLE`.
   */
  waitForExit?: true;
  /**
   * Named ports, each 0 for a free port the run assigns or a fixed number:
   * `{ smtp: 0, http: 0 }`, read as `{port:smtp}` in the service's own args,
   * env, `readyUrl`, and teardown, and as `svc.urlOf('smtp')` or
   * `svc.portOf('smtp')` elsewhere. A name is a lowercase URL scheme
   * (`http`, `smtp`, `postgres`): `svc.urlOf('smtp')` reads `smtp://host:port`.
   */
  ports?: Readonly<Record<string, number>>;
  /**
   * Command run during teardown after the service itself has stopped
   * (`docker compose down`). Runs on every exit path, is waited on until it
   * exits within its own `startupTimeout`, and a failure is recorded as a
   * cleanup-phase run error rather than a crash.
   */
  teardown?: CommandConfig;
  start?: never;
  stop?: never;
}

/** What a function service's `start` and `stop` receive. */
export interface ServiceContext {
  /** `start`: aborts on interrupt. `stop`: aborts when the cleanup budget is spent. */
  readonly signal: AbortSignal;
  /** Directory relative paths in the config resolve against. */
  readonly projectRoot: string;
  /** Where every service this one depends on, directly or through another, is served, by name. */
  readonly services: Readonly<Record<string, ServiceAddresses>>;
}

/** Where one service is served, as the run resolved it. */
export interface ServiceAddresses {
  /** The primary address, the origin of `readyUrl`; undefined without one. */
  readonly url: string | undefined;
  /** The primary port; undefined without a `readyUrl`. */
  readonly port: number | undefined;
  /** Every named port, assigned. */
  readonly ports: Readonly<Record<string, number>>;
}

/**
 * A service that is code rather than a process: global setup and teardown
 * (seeding a database, starting an in-process mock). `start` resolves once
 * the service is ready; `stop` runs at the end of the run, in reverse
 * dependency order. It has no address.
 */
export interface FunctionServiceOptions extends ServiceBase {
  start(context: ServiceContext): Promise<void>;
  stop?(context: ServiceContext): Promise<void>;
  /**
   * Budget for `start` in milliseconds; default 60000. Expiry is
   * `APP_UNREACHABLE` naming the service, and aborts the context's signal.
   */
  startupTimeout?: number;
  executable?: never;
  readyUrl?: never;
  waitForExit?: never;
  ports?: never;
  teardown?: never;
}

/** A process service or a function service; the two forms are mutually exclusive. */
export type ServiceOptions = ProcessServiceOptions | FunctionServiceOptions;

/**
 * What `defineService` returns: the one identity of a service, listed in a
 * target's `services` and in another service's `dependsOn`, and the source of
 * its address placeholders. A placeholder is a deterministic token
 * (`{service:db.url}`), not the address: the runner substitutes it wherever
 * a process is declared (the args, env, and teardown of a service or an app
 * command) and in a target's `app.url`, once the run has assigned the ports,
 * inside a longer string too (`${db.url}/api`). Tests never see the address
 * through it: opening one fails naming the service. Frozen; a spread copy is
 * not a service.
 */
export interface ServiceHandle {
  readonly name: string;
  /** Placeholder for the primary address, the origin of `readyUrl`: `http://127.0.0.1:54321`. */
  readonly url: string;
  /** Placeholder for the primary port: `54321`. */
  readonly port: string;
  /** Placeholder for a named port of `ports`, with its name as the scheme: `smtp://127.0.0.1:1025` for `urlOf('smtp')`. */
  urlOf(port: string): string;
  /** Placeholder for a named port's number: `1025` for `portOf('smtp')`. */
  portOf(port: string): string;
  readonly [serviceBrand]: true;
}
