import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from '../../src/cli/init.ts';

let dir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('e2e init', () => {
  it('scaffolds config, example test, and .gitignore entries', async () => {
    const code = await init(dir, { yes: true });
    expect(code).toBe(0);

    const config = readFileSync(path.join(dir, 'e2e.config.ts'), 'utf8');
    expect(config).toContain("defineConfig");
    expect(config).toContain("app: { url: 'localhost:3000' }");
    expect(config).toContain("import { createAgent } from '@e2edev/e2e/agent'");
    expect(config).toContain('agent: createAgent({');

    const example = readFileSync(path.join(dir, 'tests', 'example.e2e.ts'), 'utf8');
    expect(example).toContain("import { test } from '@e2edev/playwright'");
    expect(example).toContain("import { expect } from '@e2edev/e2e'");
    expect(config).toContain("backend: playwright(");

    const gitignore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.e2e/artifacts/');
    expect(gitignore).toContain('.e2e/sessions/');
    expect(gitignore).toContain('.e2e/report.json');
    expect(gitignore).toContain('.e2e/ai-trace.json');
    expect(gitignore.endsWith('\n')).toBe(true);
  });

  it('warns about the ai peer only when the project does not declare it', async () => {
    await init(dir, { yes: true });
    const written = () => stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written()).toContain('npm install --save-dev ai');

    stdoutSpy.mockClear();
    const declared = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-ai-'));
    try {
      writeFileSync(
        path.join(declared, 'package.json'),
        JSON.stringify({ devDependencies: { ai: '^7.0.0' } }),
      );
      await init(declared, { yes: true });
      expect(written()).not.toContain('npm install --save-dev ai');
    } finally {
      rmSync(declared, { recursive: true, force: true });
    }
  });

  it('never overwrites existing files', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), '// custom config\n', 'utf8');
    const code = await init(dir, { yes: true });
    expect(code).toBe(0);
    expect(readFileSync(path.join(dir, 'e2e.config.ts'), 'utf8')).toBe('// custom config\n');
    expect(existsSync(path.join(dir, 'tests', 'example.e2e.ts'))).toBe(true);
  });

  it('reconciles .gitignore entries on a project initialized before they existed', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), '// custom config\n', 'utf8');
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(path.join(dir, 'tests', 'example.e2e.ts'), '// custom test\n', 'utf8');
    const older = '.e2e/artifacts/\n.e2e/cache/\n.e2e/sessions/\n.e2e/report.json\n';
    writeFileSync(path.join(dir, '.gitignore'), older, 'utf8');
    const code = await init(dir, { yes: true });
    expect(code).toBe(0);
    expect(readFileSync(path.join(dir, 'e2e.config.ts'), 'utf8')).toBe('// custom config\n');
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(`${older}.e2e/ai-trace.json\n`);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await init(dir, { yes: true });
    const before = {
      config: readFileSync(path.join(dir, 'e2e.config.ts'), 'utf8'),
      gitignore: readFileSync(path.join(dir, '.gitignore'), 'utf8'),
    };
    const code = await init(dir, { yes: true });
    expect(code).toBe(0);
    expect(readFileSync(path.join(dir, 'e2e.config.ts'), 'utf8')).toBe(before.config);
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(before.gitignore);
  });

  it('appends only missing .gitignore entries and preserves existing content', async () => {
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.e2e/artifacts/\n', 'utf8');
    await init(dir, { yes: true });
    const gitignore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore.startsWith('node_modules/\n')).toBe(true);
    expect(gitignore.match(/\.e2e\/artifacts\//g)).toHaveLength(1);
    expect(gitignore).toContain('.e2e/sessions/');
  });

  it('adds a separating newline when .gitignore lacks a trailing newline', async () => {
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/', 'utf8');
    await init(dir, { yes: true });
    const gitignore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/\n.e2e/artifacts/');
  });
});
