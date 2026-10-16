/** The slice of the smolmachines SDK the provider uses, loaded on first use so a config load never pays for it. */

import type { ConnectOptions, Machine } from 'smolmachines';

/** Every machine runs on this computer's embedded engine; a library names its target instead of reading `SMOL_CLOUD_TOKEN`. */
const LOCAL: ConnectOptions = { target: 'local', handleSignals: false };
/** An orphan's browser may have stopped; reconnect only needs the agent to delete it. */
const LOCAL_CONNECT: ConnectOptions = { ...LOCAL, waitForPorts: false };

/** A guest port published on a host port. */
export interface Port {
  readonly host: number;
  readonly guest: number;
}

/** What a new browser machine is created with. */
export interface SmolMachineParams {
  readonly name: string;
  readonly image: string;
  readonly cpus: number;
  readonly memoryMb: number;
  /** The one published port, `guest` reached at `host` on this computer's loopback. */
  readonly port: Port;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * Keep the machine's record when the process that made it exits, so
   * another process can attach to it by name; the engine stops the VM either
   * way. Without it the engine also deletes the machine.
   */
  readonly persistent: boolean;
  /** A directory on this computer the machine sees read-only, `source` at `target`. */
  readonly mount?: { readonly source: string; readonly target: string } | undefined;
}

/** One running machine. */
export interface SmolMachine {
  readonly name: string;
  /** Runs `sh -c script`, failing on a non-zero exit with its stderr. */
  shell(script: string, signal?: AbortSignal): Promise<void>;
  /** A copy-on-write child of the running machine, the port it publishes moved to `port.host`. */
  branch(name: string, port: Port): Promise<SmolMachine>;
}

export interface SmolMachines {
  create(params: SmolMachineParams): Promise<SmolMachine>;
  /** Deletes the machine; one the engine no longer knows counts as deleted. Resolves to whether it still knew it. */
  delete(name: string): Promise<boolean>;
  /** The names of every machine the engine knows. */
  list(): Promise<string[]>;
  /** The bytes of one file on the machine's own disk. */
  readFile(name: string, file: string): Promise<Uint8Array>;
}

/** Wraps an SDK machine, remembering its handle for a later delete or read from this process. */
function wrap(machine: Machine, handles: Map<string, Machine>): SmolMachine {
  handles.set(machine.name, machine);
  return {
    name: machine.name,
    async shell(script, signal) {
      const result = await machine.exec(['sh', '-c', script], signal === undefined ? undefined : { signal });
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-5).join('; ');
        throw new Error(`machine ${machine.name}: command exited ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`);
      }
    },
    branch: async (name, port) => wrap(await machine.branch(name, { ports: [{ ...port }] }), handles),
  };
}

/** Whether an SDK error says the machine does not exist. */
function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && /not found|no such machine|does not exist/i.test(cause.message);
}

/** Concurrent first boots can race while the embedded engine configures SQLite pragmas. */
async function createWithDatabaseRetry(create: () => Promise<Machine>): Promise<Machine> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await create();
    } catch (cause) {
      if (attempt >= 3 || !(cause instanceof Error && /configure pragmas: database is locked/i.test(cause.message))) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

/** Machines on this computer's smol engine, through the SDK. */
export function smolMachines(): SmolMachines {
  const loadSdk = () => import('smolmachines');
  const handles = new Map<string, Machine>();
  /** This process's handle on the machine, else one attached by name: a lease may be released or read by another process than the one that made it. */
  const attach = async (name: string): Promise<Machine> => handles.get(name) ?? (await loadSdk()).Machine.connect(name, LOCAL_CONNECT);
  return {
    async create(params) {
      const { Machine } = await loadSdk();
      return wrap(
        await createWithDatabaseRetry(() => Machine.create(
          {
            name: params.name,
            image: params.image,
            network: true,
            branchable: true,
            // Chromium starts through exec below; no port listens during create.
            waitForPorts: false,
            ports: [{ ...params.port }],
            resources: { cpus: params.cpus, memoryMb: params.memoryMb },
            labels: { ...params.labels },
            persistent: params.persistent,
            ...(params.mount === undefined ? {} : { mounts: [{ ...params.mount, readOnly: true }] }),
          },
          LOCAL,
        )),
        handles,
      );
    },
    async delete(name) {
      try {
        await (await attach(name)).delete();
        return true;
      } catch (cause) {
        if (isNotFound(cause)) return false;
        throw cause;
      } finally {
        handles.delete(name);
      }
    },
    list: async () => (await (await loadSdk()).Machine.list(LOCAL)).map((machine) => machine.name),
    readFile: async (name, file) => new Uint8Array(await (await attach(name)).readFile(file)),
  };
}
