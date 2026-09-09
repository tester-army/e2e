import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');
const REPO_SKILL = path.join(PACKAGE_ROOT, '..', '..', 'skills', 'e2e');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-guide-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the built CLI and the bundled skill', () => {
  it('prints the overview and a topic from the package copy of the skill', async () => {
    const overview = await execFileAsync(process.execPath, [CLI, 'guide'], { cwd: dir });
    expect(overview.stdout.startsWith('# e2e')).toBe(true);
    const topic = await execFileAsync(process.execPath, [CLI, 'guide', 'writing-tests'], { cwd: dir });
    expect(topic.stdout).toBe(readFileSync(path.join(REPO_SKILL, 'references', 'writing-tests.md'), 'utf8'));
    await expect(execFileAsync(process.execPath, [CLI, 'guide', 'nope'], { cwd: dir })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('unknown topic "nope"; topics: agent, debugging, explore, running, setup, writing-tests'),
    });
    const help = await execFileAsync(process.execPath, [CLI, '--help'], { cwd: dir });
    expect(help.stdout).toContain('guide [topic]');
  });

  it('installs the skill into both agent directories with init --yes', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    for (const location of ['.agents/skills', '.claude/skills']) {
      const skill = path.join(dir, location, 'e2e', 'SKILL.md');
      expect(existsSync(skill), skill).toBe(true);
      expect(readFileSync(skill, 'utf8')).toBe(readFileSync(path.join(REPO_SKILL, 'SKILL.md'), 'utf8'));
      expect(existsSync(path.join(dir, location, 'e2e', 'references', 'setup.md'))).toBe(true);
    }
  });

  it('packs the skill files with the package', async () => {
    const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PACKAGE_ROOT });
    const [tarball] = JSON.parse(stdout) as { files: { path: string }[] }[];
    const packed = tarball?.files.map((file) => file.path) ?? [];
    expect(packed).toContain('skills/e2e/SKILL.md');
    expect(packed).toContain('skills/e2e/references/writing-tests.md');
    expect(packed).toContain('dist/cli/skill.js');
  });
});
