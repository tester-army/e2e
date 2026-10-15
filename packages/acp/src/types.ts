/** Options every ACP executor takes, whichever agent it starts. */
export interface AcpAgentOptions {
  /** Variables added to the agent's environment, on top of this process's. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * A value of the session's `model` config option, e.g. `sonnet`. The
   * session fails to start when the agent does not offer it; the error lists
   * what it does offer. Omitted, the agent's own default model runs.
   */
  readonly model?: string;
  /** Appended to the built-in rules the agent gets with the first step. */
  readonly system?: string;
  /** The executor name in reports. */
  readonly name?: string;
}

/** Options for an executor that runs agent steps on any coding agent over the Agent Client Protocol. */
export interface AcpExecutorOptions extends AcpAgentOptions {
  /**
   * The command that starts the agent in ACP mode on stdio, e.g. Cursor's
   * `agent` with `['acp']`. The agent signs in the way it does on its own
   * (its CLI login or its own API key variable).
   */
  readonly command: string;
  readonly args?: readonly string[];
  /** A session mode id to select, e.g. Codex's `read-only`. */
  readonly mode?: string;
  /** `_meta` for `session/new`: options only one agent reads (its adapter documents them). */
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
}
