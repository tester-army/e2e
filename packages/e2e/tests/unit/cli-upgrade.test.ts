import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUpgradeTarget, upgrade, type UpgradeOptions, type UpgradeTarget } from '../../src/cli/upgrade.ts';

type Releases = Record<string, Record<string, string> | { peers: Record<string, string>; deprecated: string }>;

/** A registry of `e2e` and a few siblings, each version with its peer ranges. */
const REGISTRY: Record<string, { tags: Record<string, string>; versions: Releases }> = {
  e2e: {
    tags: { latest: '0.21.2', nightly: '0.21.3-nightly-20261019081103' },
    versions: { '0.15.0': {}, '0.18.0': {}, '0.20.0': {}, '0.21.2': {}, '0.21.3-nightly-20261019081103': {} },
  },
  '@e2e-dev/web': {
    tags: { latest: '0.15.2', nightly: '0.15.3-nightly-20261019081103' },
    versions: {
      '0.12.0': { e2e: '>=0.15.0 <1' },
      '0.14.0': { e2e: '>=0.18.0 <1' },
      '0.15.1': { peers: { e2e: '>=0.18.0 <1' }, deprecated: 'broken' },
      '0.15.2': { e2e: '>=0.18.0 <1' },
      '0.15.3-nightly-20261019081103': { e2e: '0.21.3-nightly-20261019081103' },
    },
  },
  '@e2e-dev/kernel': {
    tags: { latest: '0.2.1' },
    versions: {
      '0.1.0': { e2e: '>=0.15.0 <1', '@e2e-dev/web': '>=0.11.0 <1' },
      '0.2.1': { e2e: '>=0.15.0 <1', '@e2e-dev/web': '>=0.15.0 <1' },
    },
  },
};

let dir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const fetchMock = vi.fn<typeof fetch>();
const spawnMock = vi.fn<NonNullable<UpgradeOptions['spawn']>>();

function written(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(spy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join(''));
}

/** Writes `package.json` into the project, and `node_modules/<name>` for each installed version. */
function project(manifest: Record<string, unknown>, installed: Record<string, string> = {}, at = dir): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, 'package.json'), JSON.stringify({ name: 'app', private: true, ...manifest }));
  for (const [name, version] of Object.entries(installed)) {
    mkdirSync(path.join(at, 'node_modules', name), { recursive: true });
    writeFileSync(path.join(at, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
}

async function run(target: UpgradeTarget = { kind: 'tag', tag: 'latest' }, overrides: Partial<UpgradeOptions> = {}): ReturnType<typeof upgrade> {
  return upgrade({ target, cwd: dir, env: {}, fetch: fetchMock, spawn: spawnMock, ...overrides });
}

/** The commands the upgrade ran, as one line each. */
function commands(): string[] {
  return spawnMock.mock.calls.map(([command, args]) => `${command} ${args.join(' ')}`);
}

/** The project's package.json sections as they are now. */
function sections(at = dir): Record<string, unknown> {
  const { dependencies, devDependencies, optionalDependencies } = JSON.parse(readFileSync(path.join(at, 'package.json'), 'utf8')) as Record<string, unknown>;
  return { dependencies, devDependencies, optionalDependencies };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-upgrade-'));
  // A lockfile names the manager, so the host's own does not leak in.
  writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const name = decodeURIComponent(String(input).slice('https://registry.npmjs.org/'.length));
    const entry = REGISTRY[name];
    if (entry === undefined) return new Response('{"error":"Not found"}', { status: 404 });
    const versions = Object.fromEntries(
      Object.entries(entry.versions).map(([version, release]) =>
        'deprecated' in release
          ? [version, { version, peerDependencies: release.peers, deprecated: release.deprecated }]
          : [version, { version, peerDependencies: release }],
      ),
    );
    return Response.json({ name, 'dist-tags': entry.tags, versions });
  });
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ status: 0, signal: null });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseUpgradeTarget', () => {
  it.each([
    ['latest', { kind: 'tag', tag: 'latest' }],
    ['nightly', { kind: 'tag', tag: 'nightly' }],
    ['0.22.0', { kind: 'version', version: '0.22.0' }],
    ['v0.22.0', { kind: 'version', version: '0.22.0' }],
    ['0.21.3-nightly-20261019081103', { kind: 'version', version: '0.21.3-nightly-20261019081103' }],
  ] as const)('reads %s', (value, target) => {
    expect(parseUpgradeTarget(value)).toEqual(target);
  });

  it.each(['^0.22.0', '0.22', '>=0.20.0', '0.x', ''])('refuses the range or partial version %j', (value) => {
    expect(() => parseUpgradeTarget(value)).toThrow(/not a range/u);
  });
});

describe('e2e upgrade', () => {
  it('writes every new spec into its section and installs once, keeping each spec\'s range operator', async () => {
    project(
      { devDependencies: { e2e: '^0.20.0', '@e2e-dev/web': '~0.14.0' }, dependencies: { '@e2e-dev/kernel': '^0.1.0' } },
      { e2e: '0.20.0', '@e2e-dev/web': '0.14.0', '@e2e-dev/kernel': '0.1.0' },
    );
    expect(await run()).toEqual({
      exitCode: 0,
      result: 'upgraded',
      target: { kind: 'tag', tag: 'latest' },
      fromVersion: '0.20.0',
      toVersion: '0.21.2',
      manager: 'npm',
      siblings: ['@e2e-dev/kernel', '@e2e-dev/web'],
      moved: 3,
      linked: 0,
    });
    // One install sees every new spec at once, so npm's peer check never meets the old e2e beside a new engine.
    expect(commands()).toEqual(['npm install']);
    expect(spawnMock.mock.calls[0]?.[2]).toBe(dir);
    expect(sections()).toEqual({
      dependencies: { '@e2e-dev/kernel': '^0.2.1' },
      devDependencies: { e2e: '^0.21.2', '@e2e-dev/web': '~0.15.2' },
      optionalDependencies: undefined,
    });
    const out = written(stdoutSpy);
    expect(out).toContain('e2e              0.20.0 → 0.21.2');
    expect(out).toContain('package.json: "e2e": "^0.21.2", "@e2e-dev/kernel": "^0.2.1", "@e2e-dev/web": "~0.15.2"\n$ npm install\n');
    expect(out).toContain('Upgraded: e2e 0.21.2, @e2e-dev/kernel 0.2.1, @e2e-dev/web 0.15.2');
    expect(out).toContain('Release notes: https://github.com/tester-army/e2e/releases/tag/e2e%400.21.2');
  });

  it('keeps an exact pin exact beside a caret spec, and leaves the rest of package.json as written', async () => {
    const text = '{\n\t"name": "app",\n\t"devDependencies": {\n\t\t"e2e": "0.20.0",\n\t\t"@e2e-dev/web": "^0.14.0"\n\t},\n\t"private": true\n}\n';
    writeFileSync(path.join(dir, 'package.json'), text);
    expect((await run()).exitCode).toBe(0);
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(text.replace('"0.20.0"', '"0.21.2"').replace('"^0.14.0"', '"^0.15.2"'));
  });

  it('pins a named version exactly and picks the newest sibling release whose peer range accepts it', async () => {
    project({ devDependencies: { e2e: '^0.21.2', '@e2e-dev/web': '^0.15.2', '@e2e-dev/kernel': '^0.2.1' } }, { e2e: '0.21.2', '@e2e-dev/web': '0.15.2', '@e2e-dev/kernel': '0.2.1' });
    expect((await run({ kind: 'version', version: '0.15.0' })).exitCode).toBe(0);
    // web 0.14.0 and later need e2e 0.18.0; kernel 0.2.1 needs web 0.15.0, so it follows web down.
    expect(sections()['devDependencies']).toEqual({ e2e: '0.15.0', '@e2e-dev/web': '0.12.0', '@e2e-dev/kernel': '0.1.0' });
    expect(written(stdoutSpy)).toContain('0.21.2 → 0.15.0 (downgrade)');
  });

  it('follows a dist-tag across the siblings and pins the prerelease', async () => {
    project({ devDependencies: { e2e: '^0.21.2', '@e2e-dev/web': '^0.15.2' } }, { e2e: '0.21.2', '@e2e-dev/web': '0.15.2' });
    expect((await run({ kind: 'tag', tag: 'nightly' })).exitCode).toBe(0);
    expect(sections()['devDependencies']).toEqual({ e2e: '0.21.3-nightly-20261019081103', '@e2e-dev/web': '0.15.3-nightly-20261019081103' });
    expect(written(stdoutSpy)).not.toContain('Release notes');
  });

  it('skips a deprecated sibling release, and installs with pnpm past a frozen lockfile', async () => {
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    rmSync(path.join(dir, 'package-lock.json'));
    project({ devDependencies: { e2e: '0.20.0', '@e2e-dev/web': '0.14.0' } });
    REGISTRY['@e2e-dev/web']!.tags['latest'] = '0.15.1';
    try {
      expect((await run()).exitCode).toBe(0);
    } finally {
      REGISTRY['@e2e-dev/web']!.tags['latest'] = '0.15.2';
    }
    expect(sections()['devDependencies']).toEqual({ e2e: '0.21.2', '@e2e-dev/web': '0.15.2' });
    expect(commands()).toEqual(['pnpm install --no-frozen-lockfile']);
  });

  it('changes nothing when everything is at the target', async () => {
    project({ devDependencies: { e2e: '^0.21.2', '@e2e-dev/web': '^0.15.2' } }, { e2e: '0.21.2', '@e2e-dev/web': '0.15.2' });
    expect((await run()).exitCode).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(written(stdoutSpy)).toBe('Already up to date: e2e 0.21.2, @e2e-dev/web 0.15.2\n');
  });

  it('rewrites only the packages that move', async () => {
    project({ devDependencies: { e2e: '^0.21.0', '@e2e-dev/web': '^0.14.0' } }, { e2e: '0.21.2', '@e2e-dev/web': '0.14.0' });
    expect((await run()).exitCode).toBe(0);
    expect(sections()['devDependencies']).toEqual({ e2e: '^0.21.0', '@e2e-dev/web': '^0.15.2' });
    expect(written(stdoutSpy)).not.toContain('Release notes');
  });

  it('prints the plan and changes nothing with --dry-run', async () => {
    project({ devDependencies: { e2e: '^0.20.0' } }, { e2e: '0.20.0' });
    const before = readFileSync(path.join(dir, 'package.json'), 'utf8');
    expect((await run(undefined, { dryRun: true })).exitCode).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(before);
    expect(written(stdoutSpy)).toContain('Would upgrade with npm:');
    expect(written(stdoutSpy)).toContain('package.json: "e2e": "^0.21.2"\n$ npm install\n');
  });

  it('finds the project above the working directory and installs there', async () => {
    rmSync(path.join(dir, 'package-lock.json'));
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    project({ devDependencies: { e2e: '^0.20.0' } });
    mkdirSync(path.join(dir, 'tests', 'flows'), { recursive: true });
    expect((await run(undefined, { cwd: path.join(dir, 'tests', 'flows') })).exitCode).toBe(0);
    expect(commands()).toEqual(['pnpm install --no-frozen-lockfile']);
    expect(spawnMock.mock.calls[0]?.[2]).toBe(dir);
    expect(sections()['devDependencies']).toEqual({ e2e: '^0.21.2' });
    expect(written(stdoutSpy)).toContain(`Upgrading in ${path.join('..', '..')} with pnpm:`);
    expect(written(stdoutSpy)).toContain(`${path.join('..', '..', 'package.json')}: "e2e": "^0.21.2"`);
  });

  it('leaves linked siblings alone and refuses a linked e2e', async () => {
    project({ devDependencies: { e2e: '^0.20.0', '@e2e-dev/web': 'workspace:*', '@e2e-dev/kernel': 'file:../kernel' } });
    expect((await run()).exitCode).toBe(0);
    expect(sections()['devDependencies']).toEqual({ e2e: '^0.21.2', '@e2e-dev/web': 'workspace:*', '@e2e-dev/kernel': 'file:../kernel' });
    expect(written(stdoutSpy)).toContain('Skipping @e2e-dev/web: "workspace:*" is not a registry version');

    spawnMock.mockClear();
    project({ devDependencies: { e2e: 'workspace:*' } });
    expect((await run()).exitCode).toBe(2);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toContain('e2e upgrade: e2e is "workspace:*" in package.json, not a registry version');
  });

  it('skips a sibling the registry does not have', async () => {
    project({ devDependencies: { e2e: '^0.20.0', '@e2e-dev/private-thing': '^1.0.0' } });
    expect((await run()).exitCode).toBe(0);
    expect(sections()['devDependencies']).toEqual({ e2e: '^0.21.2', '@e2e-dev/private-thing': '^1.0.0' });
    expect(written(stdoutSpy)).toContain('Skipping @e2e-dev/private-thing: the registry has no such package');
  });

  it.each([
    [{ kind: 'version', version: '9.9.9' }, 'e2e 9.9.9 was never published; the latest release is 0.21.2'],
    [{ kind: 'tag', tag: 'beta' }, 'e2e has no "beta" release; its dist-tags are latest, nightly'],
  ] as const)('exits 2 for %j', async (target, message) => {
    project({ devDependencies: { e2e: '^0.20.0' } });
    expect((await run(target)).exitCode).toBe(2);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toBe(`e2e upgrade: ${message}\n`);
  });

  it('exits 2 when no sibling release accepts the version', async () => {
    project({ devDependencies: { e2e: '^0.20.0', '@e2e-dev/web': '^0.15.0' } });
    REGISTRY['e2e']!.versions['0.10.0'] = {};
    try {
      expect((await run({ kind: 'version', version: '0.10.0' })).exitCode).toBe(2);
    } finally {
      delete REGISTRY['e2e']!.versions['0.10.0'];
    }
    expect(written(stderrSpy)).toBe('e2e upgrade: no @e2e-dev/web release works with e2e 0.10.0; @e2e-dev/web 0.15.2 needs e2e >=0.18.0 <1\n');
  });

  it('exits 2 outside a project that lists e2e', async () => {
    project({ devDependencies: { vitest: '^5.0.0' } });
    expect((await run()).exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('no package.json from here up lists e2e as a dependency');
  });

  it('exits 3 when the registry cannot be reached, and asks the registry the environment names', async () => {
    project({ devDependencies: { e2e: '^0.20.0' } });
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect((await run(undefined, { env: { npm_config_registry: 'https://npm.example.com' } })).exitCode).toBe(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://npm.example.com/e2e');
    expect(written(stderrSpy)).toBe('e2e upgrade: could not reach the registry at https://npm.example.com/: fetch failed\n');
  });

  it('puts package.json back when the installation fails or is interrupted, and exits 2 or 130', async () => {
    project({ devDependencies: { e2e: '^0.20.0' } });
    const before = readFileSync(path.join(dir, 'package.json'), 'utf8');
    const edited: string[] = [];
    spawnMock.mockImplementation((_command, _args, cwd) => {
      edited.push(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      return { status: 1, signal: null };
    });
    expect((await run()).exitCode).toBe(2);
    expect(edited[0]).toContain('"e2e": "^0.21.2"');
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(before);
    expect(written(stderrSpy)).toBe('e2e upgrade: npm install failed (exit 1); package.json is back as before. node_modules may hold some new versions until the next npm install\n');
    spawnMock.mockReturnValue({ status: null, signal: 'SIGINT' });
    expect((await run()).exitCode).toBe(130);
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('puts back a lockfile a failed install already wrote, and removes one it created', async () => {
    project({ devDependencies: { e2e: '^0.20.0' } });
    writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    spawnMock.mockImplementation((_command, _args, cwd) => {
      // npm saves the lockfile before the project's own install scripts run, and one of those fails.
      writeFileSync(path.join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"e2e":"0.21.2"}');
      writeFileSync(path.join(cwd, 'yarn.lock'), '');
      return { status: 1, signal: null };
    });
    expect((await run()).exitCode).toBe(2);
    expect(readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}');
    expect(existsSync(path.join(dir, 'yarn.lock'))).toBe(false);
    expect(written(stderrSpy)).toContain('package.json, yarn.lock, and package-lock.json are back as before');
  });

  it('holds off Ctrl-C during the install, then puts package.json back and exits 130', async () => {
    project({ devDependencies: { e2e: '^0.20.0' } });
    const before = readFileSync(path.join(dir, 'package.json'), 'utf8');
    const listeners = process.listenerCount('SIGINT');
    spawnMock.mockImplementation(() => {
      // The terminal's Ctrl-C reaches e2e as well as the package manager, which here finishes anyway.
      process.emit('SIGINT', 'SIGINT');
      return { status: 0, signal: null };
    });
    expect(await run()).toMatchObject({ exitCode: 130, result: 'install-failed' });
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(before);
    expect(written(stderrSpy)).toContain('npm install failed (interrupted)');
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });

  it('lets Yarn Berry change its lockfile in CI', async () => {
    rmSync(path.join(dir, 'package-lock.json'));
    project({ packageManager: 'yarn@4.9.2', devDependencies: { e2e: '^0.20.0' } });
    writeFileSync(path.join(dir, 'yarn.lock'), '__metadata:\n  version: 8\n');
    expect(await run(undefined, { env: { CI: 'true' } })).toMatchObject({ exitCode: 0, manager: 'yarn' });
    expect(commands()).toEqual(['yarn install']);
    expect(spawnMock.mock.calls[0]?.[3]).toMatchObject({ CI: 'true', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' });
  });

  it('puts a binary lockfile back byte for byte', async () => {
    rmSync(path.join(dir, 'package-lock.json'));
    project({ devDependencies: { e2e: '^0.20.0' } });
    // Bytes that are not UTF-8: a text round trip would turn them into replacement characters.
    const lockb = Buffer.from([0x23, 0x21, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80]);
    writeFileSync(path.join(dir, 'bun.lockb'), lockb);
    spawnMock.mockImplementation((_command, _args, cwd) => {
      writeFileSync(path.join(cwd, 'bun.lockb'), Buffer.from([0x01]));
      return { status: 1, signal: null };
    });
    expect((await run()).exitCode).toBe(2);
    expect(readFileSync(path.join(dir, 'bun.lockb')).equals(lockb)).toBe(true);
  });

  it('rewrites a package in every section that lists it', async () => {
    project({ dependencies: { '@e2e-dev/web': '^0.14.0' }, optionalDependencies: { '@e2e-dev/web': '^0.14.0' }, devDependencies: { e2e: '^0.20.0' } });
    expect((await run()).exitCode).toBe(0);
    expect(sections()).toEqual({
      dependencies: { '@e2e-dev/web': '^0.15.2' },
      devDependencies: { e2e: '^0.21.2' },
      optionalDependencies: { '@e2e-dev/web': '^0.15.2' },
    });
  });

  it('leaves a Windows path spec alone', async () => {
    project({ devDependencies: { e2e: '^0.20.0', '@e2e-dev/web': '..\\web' } });
    expect((await run()).exitCode).toBe(0);
    expect(sections()['devDependencies']).toEqual({ e2e: '^0.21.2', '@e2e-dev/web': '..\\web' });
  });

  it('exits 2 when siblings that peer on each other cannot agree', async () => {
    // Each waits on the other, so both are first picked against e2e alone; the plan as a whole must then hold.
    REGISTRY['@e2e-dev/left'] = { tags: { latest: '1.0.0' }, versions: { '1.0.0': { e2e: '>=0.15.0 <1', '@e2e-dev/right': '>=2.0.0 <3' } } };
    REGISTRY['@e2e-dev/right'] = { tags: { latest: '1.0.0' }, versions: { '1.0.0': { e2e: '>=0.15.0 <1', '@e2e-dev/left': '>=1.0.0 <2' } } };
    try {
      project({ devDependencies: { e2e: '^0.20.0', '@e2e-dev/left': '^1.0.0', '@e2e-dev/right': '^1.0.0' } });
      expect(await run()).toMatchObject({ exitCode: 2, result: 'incompatible' });
    } finally {
      delete REGISTRY['@e2e-dev/left'];
      delete REGISTRY['@e2e-dev/right'];
    }
    expect(spawnMock).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toBe('e2e upgrade: no @e2e-dev/left release fits the rest of the upgrade: @e2e-dev/left 1.0.0 needs @e2e-dev/right >=2.0.0 <3, and the upgrade picks @e2e-dev/right 1.0.0\n');
  });

  it("compares specs where node_modules holds nothing, as under Yarn Plug'n'Play", async () => {
    project({ devDependencies: { e2e: '^0.21.2', '@e2e-dev/web': '^0.14.0' } });
    expect((await run()).exitCode).toBe(0);
    expect(sections()['devDependencies']).toEqual({ e2e: '^0.21.2', '@e2e-dev/web': '^0.15.2' });
    spawnMock.mockClear();
    stdoutSpy.mockClear();
    expect(await run()).toMatchObject({ exitCode: 0, result: 'up-to-date' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(written(stdoutSpy)).toBe('Already up to date: e2e 0.21.2, @e2e-dev/web 0.15.2\n');
  });

  it('names how each run ended for telemetry, with the facts it learned before that', async () => {
    const outcome = async (target?: UpgradeTarget, overrides?: Partial<UpgradeOptions>) => {
      const { result, exitCode, fromVersion, toVersion, moved, linked } = await run(target, overrides);
      return { result, exitCode, fromVersion, toVersion, moved, linked };
    };
    project({ devDependencies: { e2e: '^0.20.0', '@e2e-dev/web': 'workspace:*' } }, { e2e: '0.20.0' });
    expect(await outcome(undefined, { dryRun: true })).toEqual({ result: 'dry-run', exitCode: 0, fromVersion: '0.20.0', toVersion: '0.21.2', moved: 0, linked: 1 });
    expect(await outcome({ kind: 'tag', tag: 'beta' })).toEqual({ result: 'unknown-target', exitCode: 2, fromVersion: '0.20.0', toVersion: null, moved: 0, linked: 1 });
    spawnMock.mockReturnValue({ status: null, signal: 'SIGINT' });
    expect(await outcome()).toMatchObject({ result: 'install-failed', exitCode: 130, moved: 0 });

    project({ devDependencies: { e2e: '^0.21.2' } }, { e2e: '0.21.2' });
    expect(await outcome()).toMatchObject({ result: 'up-to-date', exitCode: 0, fromVersion: '0.21.2', toVersion: '0.21.2' });
    rmSync(path.join(dir, 'node_modules'), { recursive: true });
    spawnMock.mockReturnValue({ status: 0, signal: null });
    project({ devDependencies: { e2e: '^0.20.0', '@e2e-dev/web': '^0.15.0' } });
    expect(await outcome({ kind: 'version', version: '0.18.0' })).toEqual({ result: 'upgraded', exitCode: 0, fromVersion: null, toVersion: '0.18.0', moved: 2, linked: 0 });
    project({ devDependencies: { e2e: 'link:../e2e' } });
    expect(await outcome()).toMatchObject({ result: 'linked', exitCode: 2, toVersion: null, linked: 1 });
    project({ devDependencies: {} });
    expect(await outcome()).toMatchObject({ result: 'no-project', exitCode: 2 });
    writeFileSync(path.join(dir, 'package.json'), '{');
    expect(await outcome()).toMatchObject({ result: 'invalid-project', exitCode: 2 });
    project({ devDependencies: { e2e: '^0.20.0' } });
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    expect(await outcome()).toMatchObject({ result: 'registry-failed', exitCode: 3 });
  });

  it('names a sibling with no release that fits as incompatible', async () => {
    project({ devDependencies: { e2e: '^0.20.0', '@e2e-dev/web': '^0.15.0' } });
    REGISTRY['e2e']!.versions['0.10.0'] = {};
    try {
      expect(await run({ kind: 'version', version: '0.10.0' })).toMatchObject({ result: 'incompatible', target: { kind: 'version' }, toVersion: '0.10.0' });
    } finally {
      delete REGISTRY['e2e']!.versions['0.10.0'];
    }
  });

  it('points at init when the project holds a copy of the agent skill', async () => {
    project({ devDependencies: { e2e: '^0.20.0' } }, { e2e: '0.20.0' });
    mkdirSync(path.join(dir, '.agents', 'skills', 'e2e'), { recursive: true });
    expect((await run()).exitCode).toBe(0);
    expect(written(stdoutSpy)).toContain('The agent skill in .agents/skills/e2e is the old version\'s; refresh it with npm exec -- e2e init');
  });
});
