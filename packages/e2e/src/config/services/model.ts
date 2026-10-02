/** The shapes of the service resolution: templates before the run's ports, resolved services after. */

import type { CommandConfig, ServiceAddresses, ServiceContext } from '../../types.ts';
import type { Readiness, ResolvedCommand } from '../command.ts';

/** The free ports the run assigned, keyed as `portKey` spells them. */
export type PortAssignments = Readonly<Record<string, number>>;

/** One free port the run must assign before anything spawns. */
export interface PortRequest {
  /** Where a worker's bootstrap carries it (`portKey`). */
  readonly key: string;
  /** The address to bind. */
  readonly host: string;
  /** What asked for it, for the error when it cannot be bound. */
  readonly owner: string;
}

/**
 * The primary address of a process, what `svc.url`, `svc.port`, and `{port}`
 * read: its `readyUrl` for a service, its `app.url` for an app command. The
 * port is its own (0 asks for a free one), or one of its named ports.
 */
export interface PrimaryAddress {
  readonly scheme: string;
  readonly host: string;
  readonly port: { readonly number: number } | { readonly named: string };
}

export interface TemplateBase {
  readonly name: string;
  /** How errors and the reporter name it: `service "db"`, `target "web" command`. */
  readonly label: string;
  /** How a run narrates it: a service, or the process a target's `app.command` is. */
  readonly role: 'service' | 'app';
  /** Every service it depends on, directly or through another, in start order. */
  readonly dependencies: readonly string[];
}

/** A process as checked, before the run's ports: every string holds tokens, its own ports included. */
export interface ProcessTemplate extends TemplateBase {
  readonly kind: 'process';
  readonly command: CommandConfig;
  readonly readyUrl: string | undefined;
  readonly teardown: CommandConfig | undefined;
  readonly primary: PrimaryAddress | undefined;
  /** Named ports, each 0 for a free one. */
  readonly ports: Readonly<Record<string, number>>;
  /** The host the named ports bind and read on. */
  readonly namedHost: string;
}

/** A function service as checked. */
export interface FunctionTemplate extends TemplateBase {
  readonly kind: 'function';
  readonly start: (context: ServiceContext) => Promise<void>;
  readonly stop: ((context: ServiceContext) => Promise<void>) | undefined;
  readonly startupTimeout: number;
}

export type ServiceTemplate = ProcessTemplate | FunctionTemplate;

interface ResolvedBase extends TemplateBase {
  /**
   * The service's identity across attempts that share processes: its name,
   * how it spawns and settles (a process), and its dependencies' keys, so
   * one started against another instance of a dependency is its own. A
   * function service is its name and dependencies alone: a config reload
   * that edits its hooks shares the instance already running.
   */
  readonly key: string;
  /** Where every service it depends on is served, by name: a function service's `context.services`. */
  readonly services: Readonly<Record<string, ServiceAddresses>>;
}

/** A process bound to the run's ports: what the runner spawns and probes. */
export interface ResolvedProcessService extends ResolvedBase {
  readonly kind: 'process';
  readonly template: ProcessTemplate;
  readonly command: CommandConfig;
  readonly readiness: Readiness;
  readonly teardown: ResolvedCommand | undefined;
  readonly address: ServiceAddresses;
}

/** A function service, run in the runner process. */
export interface ResolvedFunctionService extends ResolvedBase {
  readonly kind: 'function';
  readonly template: FunctionTemplate;
}

export type ResolvedService = ResolvedProcessService | ResolvedFunctionService;
