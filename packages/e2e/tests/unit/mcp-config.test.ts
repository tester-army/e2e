import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const ENTRY = { command: 'npx', args: ['e2e', 'mcp'] };

describe('planMcpRegistration', () => {
  it('creates each missing file with the e2e server entry', () => {
    const plans = planMcpRegistration(dir, MCP_LOCATIONS.map((location) => location.file));
    expect(plans.map((plan) => [plan.relative, plan.existing])).toEqual([
      ['.mcp.json', false],
      ['.cursor/mcp.json', false],
    ]);
    expect(JSON.parse(plans[0]!.content)).toEqual({ mcpServers: { e2e: ENTRY } });
    expect(plans[0]!.content.endsWith('\n')).toBe(true);
  });

  it('merges into an existing file, keeping other servers, keys, and indentation', () => {
    const existing = '{\n    "mcpServers": {\n        "figma": { "command": "figma-mcp" }\n    },\n    "other": true\n}\n';
    writeFileSync(path.join(dir, '.mcp.json'), existing);
    const [plan] = planMcpRegistration(dir, ['.mcp.json']);
    expect(plan!.existing).toBe(true);
    expect(JSON.parse(plan!.content)).toEqual({ mcpServers: { figma: { command: 'figma-mcp' }, e2e: ENTRY }, other: true });
    expect(plan!.content).toContain('\n    "mcpServers"');
  });

  it('plans nothing for a file that already registers the same entry, and finds it', () => {
    mkdirSync(path.join(dir, '.cursor'));
    writeFileSync(path.join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { e2e: ENTRY } }));
    expect(planMcpRegistration(dir, ['.cursor/mcp.json'])).toEqual([]);
    expect(findRegisteredMcpFiles(dir)).toEqual(['.cursor/mcp.json']);
    // A stale entry is repaired, not treated as registered.
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { e2e: { command: 'e2e', args: ['mcp'] } } }));
    expect(planMcpRegistration(dir, ['.mcp.json'])).toHaveLength(1);
    expect(findRegisteredMcpFiles(dir)).toEqual(['.mcp.json', '.cursor/mcp.json']);
  });

  it('refuses to overwrite a file that is not JSON', () => {
    writeFileSync(path.join(dir, '.mcp.json'), '{ not json');
    expect(() => planMcpRegistration(dir, ['.mcp.json'])).toThrow(/is not valid JSON/);
    expect(findRegisteredMcpFiles(dir)).toEqual([]);
    expect(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toBe('{ not json');
  });
});
