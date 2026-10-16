import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRegisteredMcpFiles, MCP_LOCATIONS, planMcpRegistration } from '../../src/cli/init/mcp-config.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Whether this host lets the tests create file symlinks; Windows needs a privilege for them. */
const symlinks = ((): boolean => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-symlink-'));
  try {
    writeFileSync(path.join(probe, 'file'), '');
    symlinkSync(path.join(probe, 'file'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

// A junction works on Windows without the symlink privilege, and a symlink on POSIX; POSIX needs the privilege.
const canLinkDir = process.platform === 'win32' || symlinks;

const ENTRY = { command: 'npx', args: ['e2e', 'mcp'] };

describe('planMcpRegistration', () => {
  it('creates each missing file with the e2e server entry', () => {
    const { registrations } = planMcpRegistration(dir, MCP_LOCATIONS.map((location) => location.file));
    expect(registrations.map((plan) => [plan.relative, plan.existing])).toEqual([
      ['.mcp.json', false],
      ['.cursor/mcp.json', false],
    ]);
    expect(JSON.parse(registrations[0]!.content)).toEqual({ mcpServers: { e2e: ENTRY } });
    expect(registrations[0]!.content.endsWith('\n')).toBe(true);
  });

  it('merges into an existing file, keeping other servers, keys, and indentation', () => {
    const existing = '{\n    "mcpServers": {\n        "figma": { "command": "figma-mcp" }\n    },\n    "other": true\n}\n';
    writeFileSync(path.join(dir, '.mcp.json'), existing);
    const [plan] = planMcpRegistration(dir, ['.mcp.json']).registrations;
    expect(plan!.existing).toBe(true);
    expect(JSON.parse(plan!.content)).toEqual({ mcpServers: { figma: { command: 'figma-mcp' }, e2e: ENTRY }, other: true });
    expect(plan!.content).toContain('\n    "mcpServers"');
  });

  it('plans nothing for a file that already registers the same entry, and finds it', () => {
    mkdirSync(path.join(dir, '.cursor'));
    writeFileSync(path.join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { e2e: ENTRY } }));
    expect(planMcpRegistration(dir, ['.cursor/mcp.json']).registrations).toEqual([]);
    expect(findRegisteredMcpFiles(dir)).toEqual(['.cursor/mcp.json']);
    // A stale entry is repaired, not treated as registered.
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { e2e: { command: 'e2e', args: ['mcp'] } } }));
    expect(planMcpRegistration(dir, ['.mcp.json']).registrations).toHaveLength(1);
    expect(findRegisteredMcpFiles(dir)).toEqual(['.mcp.json', '.cursor/mcp.json']);
  });

  it('keeps extra settings on an already current server without rewriting the file', () => {
    const entry = { ...ENTRY, env: { APP_ENV: 'staging' }, timeout: 30_000 };
    const original = JSON.stringify({ mcpServers: { e2e: entry } }, null, 4) + '\n';
    writeFileSync(path.join(dir, '.mcp.json'), original);
    expect(planMcpRegistration(dir, ['.mcp.json']).registrations).toEqual([]);
    expect(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toBe(original);
  });

  it('repairs a stale launch command without dropping environment or client settings', () => {
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { e2e: { command: 'e2e', args: ['mcp'], env: { APP_ENV: 'staging' }, timeout: 30_000 } },
      other: true,
    }));
    const [plan] = planMcpRegistration(dir, ['.mcp.json']).registrations;
    expect(JSON.parse(plan!.content)).toEqual({ mcpServers: { e2e: { ...ENTRY, env: { APP_ENV: 'staging' }, timeout: 30_000 } }, other: true });
  });

  it('refuses to overwrite a file that is not JSON', () => {
    writeFileSync(path.join(dir, '.mcp.json'), '{ not json');
    expect(() => planMcpRegistration(dir, ['.mcp.json'])).toThrow(/is not valid JSON/);
    expect(findRegisteredMcpFiles(dir)).toEqual([]);
    expect(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toBe('{ not json');
  });

  it.skipIf(!canLinkDir)('never plans a write through a linked directory, and reports the link', () => {
    // A junction works on Windows without the symlink privilege, and a symlink on POSIX.
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-elsewhere-'));
    try {
      // The target already registers e2e: discovery must not follow the link and call it registered.
      writeFileSync(path.join(elsewhere, 'mcp.json'), JSON.stringify({ mcpServers: { e2e: ENTRY } }));
      symlinkSync(elsewhere, path.join(dir, '.cursor'), 'junction');
      const { registrations, links } = planMcpRegistration(dir, ['.cursor/mcp.json']);
      expect(registrations).toEqual([]);
      expect(links).toEqual([{ relative: '.cursor', target: realpathSync(elsewhere) }]);
      // Nothing was written through the link, and it is not counted as registered.
      expect(readdirSync(elsewhere)).toEqual(['mcp.json']);
      expect(findRegisteredMcpFiles(dir)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(!symlinks)('never plans a write through a linked file, and reports the link', () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-elsewhere-'));
    try {
      const target = path.join(elsewhere, 'real.json');
      // The target already registers e2e: discovery must not follow the link and call it registered.
      const original = JSON.stringify({ mcpServers: { e2e: ENTRY, other: { command: 'x' } } });
      writeFileSync(target, original);
      symlinkSync(target, path.join(dir, '.mcp.json'), 'file');
      const { registrations, links } = planMcpRegistration(dir, ['.mcp.json']);
      expect(registrations).toEqual([]);
      expect(links).toEqual([{ relative: '.mcp.json', target: realpathSync(target) }]);
      // The target is untouched: nothing was read or written through the link, and it is not counted as registered.
      expect(readFileSync(target, 'utf8')).toBe(original);
      expect(lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink()).toBe(true);
      expect(findRegisteredMcpFiles(dir)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
