/**
 * What one `e2e mcp` session did, kept beside it for whoever is told when it
 * ends: the CLI turns it into telemetry. The host fills it from facts it
 * already holds; nothing here reads an argument, a result, or a screen. A
 * project tool counts under one number, never its name, and an error under
 * its runner code alone.
 */

/** How a session ended: the agent's `close_session`, idleness, its step concluding (the TTL), or the server going away. */
export type SessionEndedBy = 'agent' | 'idle' | 'step' | 'server';

/** One session, from `open_session` to its close or failed open. */
export interface McpSessionSummary {
  /** `closed` for a session that went live, `open-failed` for an `open_session` that did not. */
  readonly outcome: 'closed' | 'open-failed';
  /** Undefined for a failed open. */
  readonly endedBy: SessionEndedBy | undefined;
  /** The runner code an open failed with; undefined for a session that went live. */
  readonly openErrorCode: string | undefined;
  /** Undefined when the open failed before the target resolved. */
  readonly platform: string | undefined;
  /** Undefined before the target resolved, and for a target without an engine. */
  readonly engine: SessionEngine | undefined;
  readonly headed: boolean;
  readonly durationMs: number;
  /** Sessions live beside this one when it opened. */
  readonly concurrent: number;
  /** Calls of the built-in catalog tools, by name. */
  readonly toolCalls: ReadonlyMap<string, number>;
  /** Calls of the project's own tools, together. */
  readonly projectToolCalls: number;
  /** Calls whose result was an error, a tool the session does not have included. */
  readonly failedCalls: number;
  /** How often each runner code failed a call. */
  readonly errorCodes: ReadonlyMap<string, number>;
}

/** The engine a session's target declares, by its own name and version. */
export interface SessionEngine {
  readonly name: string;
  readonly version: string;
}

/** The runner code a failed grammar result leads with: `tap #n9 failed: LOCATOR_NOT_FOUND: …`. */
const FAILED_RESULT_CODE = / failed: ([A-Z][A-Z0-9_]{2,63}):/u;

/** The code a failed result's first line names, when it names one. */
export function failedResultCode(text: string): string | undefined {
  return FAILED_RESULT_CODE.exec(text.split('\n', 1)[0] ?? '')?.[1];
}

/** The live counters of one session. */
export class SessionUsage {
  private readonly startedAt = Date.now();
  private readonly toolCalls = new Map<string, number>();
  private projectToolCalls = 0;
  private failedCalls = 0;
  private readonly errorCodes = new Map<string, number>();
  private target: { readonly platform: string; readonly engine: SessionEngine | undefined } | undefined;

  constructor(
    private readonly concurrent: number,
    private readonly headed: boolean,
  ) {}

  /** Notes the target once the open resolved it, so a later failure still names the platform it failed on. */
  resolved(platform: string, engine: SessionEngine | undefined): void {
    this.target = { platform, engine };
  }

  /** Counts one call of a catalog tool. */
  called(name: string, project: boolean): void {
    if (project) this.projectToolCalls += 1;
    else this.toolCalls.set(name, (this.toolCalls.get(name) ?? 0) + 1);
  }

  /** Counts one failed call, under its code when it has one. */
  failed(code: string | undefined): void {
    this.failedCalls += 1;
    if (code !== undefined) this.errorCodes.set(code, (this.errorCodes.get(code) ?? 0) + 1);
  }

  /** The summary of a session that went live and has now closed. */
  closed(endedBy: SessionEndedBy): McpSessionSummary {
    return {
      outcome: 'closed',
      endedBy,
      openErrorCode: undefined,
      platform: this.target?.platform,
      engine: this.target?.engine,
      headed: this.headed,
      durationMs: Date.now() - this.startedAt,
      concurrent: this.concurrent,
      toolCalls: new Map(this.toolCalls),
      projectToolCalls: this.projectToolCalls,
      failedCalls: this.failedCalls,
      errorCodes: new Map(this.errorCodes),
    };
  }

  /** The summary of an `open_session` that failed with `code`. */
  openFailed(code: string): McpSessionSummary {
    return {
      outcome: 'open-failed',
      endedBy: undefined,
      openErrorCode: code,
      platform: this.target?.platform,
      engine: this.target?.engine,
      headed: this.headed,
      durationMs: Date.now() - this.startedAt,
      concurrent: this.concurrent,
      toolCalls: new Map(),
      projectToolCalls: 0,
      failedCalls: 0,
      errorCodes: new Map(),
    };
  }
}
