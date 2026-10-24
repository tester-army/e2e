import { mkdir, readFile, open, rename, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

/** Owns ordered profile reads and atomic durable operations in one server process. */
export class ProfileStore {
  #queues = new Map();
  constructor(directory, initial, change) {
    this.directory = directory;
    this.initial = initial;
    this.change = change;
  }

  /** Serializes an operation behind all prior reads and writes for its profile. */
  async #ordered(profile, run) {
    if (!/^[0-9a-f-]{36}$/.test(profile)) throw new Error('Invalid profile');
    const prior = this.#queues.get(profile) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(run);
    this.#queues.set(profile, next);
    try { return await next; } finally { if (this.#queues.get(profile) === next) this.#queues.delete(profile); }
  }

  /** Reads the committed envelope, creating it durably on first use. */
  async #load(profile) {
    const path = join(this.directory, profile + '.json');
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const envelope = { state: this.initial(), operations: {} };
      await this.#commit(profile, envelope);
      return envelope;
    }
  }

  /** Flushes the complete replacement before the atomic rename and acknowledgment. */
  async #commit(profile, envelope) {
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, profile + '.' + randomUUID() + '.tmp');
    const destination = join(this.directory, profile + '.json');
    const backup = temporary + '.previous';
    let handle;
    let directory;
    let hadPrevious = false;
    let replaced = false;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(envelope));
      await handle.sync();
      await handle.close();
      handle = null;
      directory = await open(this.directory, 'r');
      try { await link(destination, backup); hadPrevious = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await directory.sync();
      await rename(temporary, destination);
      replaced = true;
      await directory.sync();
    } catch (error) {
      if (replaced) {
        if (hadPrevious) await rename(backup, destination);
        else await unlink(destination);
        await directory.sync();
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
      await directory?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      await unlink(backup).catch(() => {});
    }
  }

  /** Returns the latest committed aggregate after prior submitted operations. */
  async read(profile) {
    return this.#ordered(profile, async () => structuredClone((await this.#load(profile)).state));
  }

  /** Commits a command once and rejects operation-ID reuse with another payload. */
  async execute(profile, operation) {
    const submitted = Promise.resolve(operation);
    submitted.catch(() => {});
    return this.#ordered(profile, async () => {
      const { operationId, command } = await submitted;
      if (typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(operationId)) throw new Error('Invalid operation ID');
      const envelope = await this.#load(profile);
      const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const previous = envelope.operations[operationId];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('Operation ID reused with different input');
        return { state: structuredClone(envelope.state), result: previous.result };
      }
      const update = this.change(envelope.state, command);
      update.state.revision = (envelope.state.revision ?? 0) + 1;
      const next = { state: update.state, operations: { ...envelope.operations, [operationId]: { fingerprint, result: update.result } } };
      await this.#commit(profile, next);
      return structuredClone(update);
    });
  }
}
