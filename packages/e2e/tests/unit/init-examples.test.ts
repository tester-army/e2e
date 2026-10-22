import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as clack from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from '../../src/cli/init.ts';
import { EXAMPLES, extractFolder, findExample } from '../../src/cli/init/examples.ts';
import { dependencyRange } from '../../src/cli/init/versions.ts';

vi.mock('@clack/prompts', { spy: true });
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const RUNNER_VERSION = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }).version;

interface Entry {
  readonly name: string;
  readonly content?: string;
  readonly mode?: number;
  readonly type?: '0' | '5' | 'x' | 'L' | 'g' | '2';
}

/** One 512-byte ustar header. */
function header(name: string, size: number, mode: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\u000000', 257, 'ascii');
  return block;
}

/** A tar archive of the entries, padded the way tar pads them. */
function tar(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '', 'utf8');
    blocks.push(header(entry.name, data.length, entry.mode ?? 0o644, entry.type ?? '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A pax `path` record, length prefix included. */
function paxRecord(value: string): string {
  const body = ` path=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
}

/** The archive split into small chunks, as a network body arrives. */
async function* chunks(buffer: Buffer, size = 700): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}

/** A GitHub tarball of the `with-vite` example as the codeload service serves it. */
function viteTarball(root = 'e2e-e2e-1.0.0'): Buffer {
  return gzipSync(
    tar([
      { name: 'pax_global_header', type: 'g', content: '52 comment=0123456789abcdef0123456789abcdef01234567\n' },
      { name: `${root}/`, type: '5' },
      { name: `${root}/apps/readme.md`, content: 'not an example' },
      { name: `${root}/examples/`, type: '5' },
      { name: `${root}/examples/with-vite/`, type: '5' },
      { name: `${root}/examples/with-vite/package.json`, content: '{\n  "name": "e2e-example-with-vite",\n  "private": true,\n  "scripts": { "test:e2e": "e2e run" },\n  "devDependencies": { "e2e": "^0.15.2", "@e2e-dev/web": "^0.11.1", "vite": "^8.3.2" }\n}\n' },
      { name: `${root}/examples/with-vite/e2e.config.ts`, content: 'export default {};\n' },
      { name: `${root}/examples/with-vite/.gitignore`, content: 'node_modules/\n' },
      { name: `${root}/examples/with-vite/tests/`, type: '5' },
      { name: `${root}/examples/with-vite/tests/deterministic.e2e.ts`, content: '// tests\n' },
      { name: `${root}/examples/with-vite/tsconfig.json`, content: '{}\n' },
      { name: `${root}/examples/with-vue/never.txt`, content: 'past the folder' },
    ]),
  );
}

let dir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

/** Captured user-facing output. */
function output(): string {
  return stdoutSpy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join('');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-example-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.stubEnv('npm_config_user_agent', 'npm/11.0.0');
  vi.mocked(clack.confirm).mockReset().mockResolvedValue(true);
  vi.mocked(clack.select).mockReset();
  vi.mocked(clack.multiselect).mockReset().mockResolvedValue([]);
  vi.mocked(clack.isCancel).mockImplementation((value) => typeof value === 'symbol');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('example presets', () => {
  it('list every standalone app in examples/, each with its e2e project and the script the Next line names', () => {
    const folders = readdirSync(path.join(REPO_ROOT, 'examples'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'with-limrun')
      .map((entry) => entry.name)
      .toSorted();
    expect(EXAMPLES.map((example) => example.id).toSorted()).toEqual(folders);
    for (const example of EXAMPLES) {
      const project = path.join(REPO_ROOT, 'examples', example.id, example.project);
      expect(existsSync(path.join(project, 'e2e.config.ts')), example.id).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      expect(manifest.scripts?.[example.script], `${example.id} ${example.script}`).toBeDefined();
    }
  });

  it('accept the folder name with or without with-', () => {
    expect(findExample('expo')?.id).toBe('with-expo');
    expect(findExample('with-flutter')?.id).toBe('with-flutter');
    expect(findExample('with-limrun')).toBeUndefined();
  });
});

describe('extractFolder', () => {
  it('writes the folder without its prefix, keeps executables executable, and stops past the folder', async () => {
    const longName = `e2e-main/examples/with-x/${'deep/'.repeat(30)}file.txt`;
    const archive = tar([
      { name: 'e2e-main/examples/with-x/gradlew', content: '#!/bin/sh\n', mode: 0o755 },
      { name: 'PaxHeader', type: 'x', content: paxRecord(longName) },
      { name: 'ignored-short-name', content: 'from pax' },
      { name: '././@LongLink', type: 'L', content: 'e2e-main/examples/with-x/gnu-long.txt\0' },
      { name: 'ignored-too', content: 'from gnu' },
      { name: 'e2e-main/examples/with-x/link', type: '2' },
      { name: 'e2e-main/examples/with-y/after.txt', content: 'never read' },
    ]);
    const top: string[] = [];
    expect(await extractFolder(chunks(archive), 'examples/with-x/', dir, (entry) => top.push(entry))).toBe(3);
    expect(readFileSync(path.join(dir, 'gradlew'), 'utf8')).toBe('#!/bin/sh\n');
    if (process.platform !== 'win32') expect(statSync(path.join(dir, 'gradlew')).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(dir, ...'deep/'.repeat(30).split('/').filter(Boolean), 'file.txt'), 'utf8')).toBe('from pax');
    expect(readFileSync(path.join(dir, 'gnu-long.txt'), 'utf8')).toBe('from gnu');
    expect(existsSync(path.join(dir, 'link'))).toBe(false);
    expect(existsSync(path.join(dir, 'after.txt'))).toBe(false);
    expect(new Set(top)).toEqual(new Set(['gradlew', 'deep', 'gnu-long.txt', 'link']));
  });

  it('refuses a path that leaves the destination', async () => {
    const archive = tar([{ name: 'e2e-main/examples/with-x/../../escape.txt', content: 'no' }]);
    await expect(extractFolder(chunks(archive), 'examples/with-x/', dir, () => {})).rejects.toThrow('unsafe path');
    expect(existsSync(path.join(dir, '..', 'escape.txt'))).toBe(false);
  });
});

describe('e2e init --example', () => {
  it('copies the example from the release tag and runs the wizard on it without adding scaffold files', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(viteTarball())));
    vi.stubGlobal('fetch', fetchMock);
    const target = path.join(dir, 'my-app');
    const outcome = await init(target, { yes: true, example: 'with-vite', directory: 'my-app' });
    expect(outcome).toMatchObject({ exitCode: 0, result: 'scaffolded', example: 'with-vite', existingConfig: true, engine: null });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`https://codeload.github.com/tester-army/e2e/tar.gz/refs/tags/e2e%40${RUNNER_VERSION}`);
    // The example's stale runner pin moves to this CLI's range; from source no sibling version is recorded, so the engine pin stays.
    expect(JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'))).toEqual({
      name: 'my-app',
      private: true,
      scripts: { 'test:e2e': 'e2e run' },
      devDependencies: { 'e2e': dependencyRange(RUNNER_VERSION), '@e2e-dev/web': '^0.11.1', 'vite': '^8.3.2' },
    });
    expect(readFileSync(path.join(target, 'e2e.config.ts'), 'utf8')).toBe('export default {};\n');
    expect(existsSync(path.join(target, 'tests', 'example.e2e.ts'))).toBe(false);
    expect(existsSync(path.join(target, '.agents/skills/e2e/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(target, '.mcp.json'))).toBe(true);
    expect(readFileSync(path.join(target, '.gitignore'), 'utf8')).toContain('.e2e/results/');
    expect(output()).not.toContain('Add scripts');
    expect(output()).toContain('Next: cd my-app, then npm install, then npm run test:e2e');
  });

  it('falls back to main when the tag is missing and says so', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes('refs/tags/') ? new Response('', { status: 404 }) : new Response(new Uint8Array(viteTarball('e2e-main')))));
    vi.stubGlobal('fetch', fetchMock);
    expect((await init(dir, { yes: true, example: 'vite' })).result).toBe('scaffolded');
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toBe('https://codeload.github.com/tester-army/e2e/tar.gz/refs/heads/main');
    expect(output()).toContain('used the examples on main');
    expect(existsSync(path.join(dir, 'e2e.config.ts'))).toBe(true);
  });

  it('refuses a directory with files in it before downloading anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    expect(await init(dir, { yes: true, example: 'with-vite' })).toMatchObject({ exitCode: 2, result: 'invalid-project' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(['notes.txt']);
  });

  it('leaves nothing behind when the download fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const target = path.join(dir, 'app');
    expect(await init(target, { yes: true, example: 'with-vite' })).toMatchObject({ exitCode: 2, result: 'example-failed' });
    expect(existsSync(target)).toBe(false);
    expect(output()).toContain('fetch failed');
  });

  it('stops the download on Ctrl-C, removes the partial copy, and exits 130', async () => {
    // Half the archive arrives, then the connection stalls until the request is aborted, as a real fetch body does.
    const archive = new Uint8Array(viteTarball());
    vi.stubGlobal('fetch', vi.fn(async (_url: string, request?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(archive.subarray(0, Math.floor(archive.length / 2)));
        request?.signal?.addEventListener('abort', () => stream.error(request.signal?.reason));
      },
    }))));
    // The spinner owns SIGINT while it spins; a stand-in fires its cancel once the download is under way.
    vi.mocked(clack.spinner).mockImplementation((options) => ({
      start: () => { setTimeout(() => options?.onCancel?.(), 20); },
      stop: () => {},
      cancel: () => {},
      error: () => {},
      message: () => {},
      clear: () => {},
      isCancelled: false,
    }));
    const target = path.join(dir, 'app');
    expect(await init(target, { yes: true, example: 'with-vite' })).toMatchObject({ exitCode: 130, result: 'cancelled' });
    expect(existsSync(target)).toBe(false);
  });

  it('removes the copied example when the wizard is cancelled, keeping what was there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(viteTarball()))));
    mkdirSync(path.join(dir, '.git'));
    vi.mocked(clack.confirm).mockResolvedValue(false);
    expect(await init(dir, { interactive: true, example: 'with-vite', skills: [], mcp: [] })).toMatchObject({ exitCode: 0, result: 'cancelled' });
    expect(readdirSync(dir)).toEqual(['.git']);
  });
});
