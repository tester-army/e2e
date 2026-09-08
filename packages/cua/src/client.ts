/**
 * The seam between the engine and Cua Driver: one `call(tool, args)` over the
 * in-process runtime `@trycua/cua-driver` loads, and nothing else. The
 * surface programs against this interface so unit tests script it without a
 * native binary or an Accessibility grant, and so a daemon-backed client can
 * replace it without touching the engine.
 */

/** One image Cua Driver attached to a tool result. */
export interface DriverImage {
  readonly mimeType: string;
  readonly dataBase64: string;
}

/** The subset of Cua Driver's `ToolResult` the engine reads. */
export interface DriverToolResult {
  readonly text: string;
  readonly images: readonly DriverImage[];
  /** JSON of the tool's `structuredContent`, when the tool produced one. */
  readonly structuredJson?: string;
  readonly isError: boolean;
  readonly errorCode?: string;
  /** The action outcome record of an action tool, in Cua Driver's own shape. */
  readonly action?: unknown;
  readonly degraded: boolean;
}

export interface DriverClient {
  /** Runs one Cua Driver tool by its MCP name with JSON-serialisable arguments. */
  call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<DriverToolResult>;
  /** Stops accepting operations and releases the native handle. Idempotent. */
  shutdown(): Promise<void>;
}

/** Mints the client for one engine; the seam unit tests script. */
export type ClientFactory = () => DriverClient;

interface NativeDriver {
  callTool(name: string, argumentsJson: string, options?: { signal: AbortSignal }): Promise<DriverToolResult>;
  shutdown(options?: { signal: AbortSignal }): Promise<void>;
  uniffiDestroy(): void;
}

/**
 * The production client: a same-process Cua Driver runtime, created on the
 * first call so that loading the config never loads the native binary and an
 * unsupported host fails inside `init`, where the runner reports it as
 * infrastructure.
 */
export function createDriverClient(): DriverClient {
  let driver: Promise<NativeDriver> | undefined;
  let closed = false;
  const open = (): Promise<NativeDriver> => {
    driver ??= import('@trycua/cua-driver').then((sdk) => sdk.CuaDriver.create(undefined) as unknown as NativeDriver);
    return driver;
  };
  return {
    async call(name, args, signal) {
      if (closed) throw new Error('the Cua Driver client is shut down');
      const runtime = await open();
      return runtime.callTool(name, JSON.stringify(args), { signal });
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      if (driver === undefined) return;
      const runtime = await driver.catch(() => undefined);
      if (runtime === undefined) return;
      try {
        await runtime.shutdown();
      } finally {
        runtime.uniffiDestroy();
      }
    },
  };
}
