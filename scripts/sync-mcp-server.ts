/**
 * Keep packages/e2e/server.json, the MCP Registry entry, on the runner's
 * version and name. `version-packages` runs it after `changeset version`, so
 * the release commit carries the entry `mcp-registry.yml` publishes. Use
 * --check in CI to report a stale entry.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import runner from '../packages/e2e/package.json' with { type: 'json' };

const path = fileURLToPath(new URL('../packages/e2e/server.json', import.meta.url));
const check = process.argv.includes('--check');

interface ServerEntry {
  name: string;
  version: string;
  packages: { identifier: string; version: string }[];
}

const current = readFileSync(path, 'utf8');
const server = JSON.parse(current) as ServerEntry;
if (!server.packages.some((entry) => entry.identifier === runner.name)) {
  process.stderr.write(`packages/e2e/server.json lists no ${runner.name} package\n`);
  process.exit(1);
}
const synced: ServerEntry = {
  ...server,
  name: runner.mcpName,
  version: runner.version,
  packages: server.packages.map((entry) =>
    entry.identifier === runner.name ? { ...entry, version: runner.version } : entry,
  ),
};
const next = `${JSON.stringify(synced, null, 2)}\n`;

if (next === current) {
  process.stdout.write(`MCP server entry: ${check ? 'checked' : 'synced'} ${runner.mcpName}@${runner.version}\n`);
} else if (check) {
  process.stderr.write('packages/e2e/server.json is out of date; run pnpm mcp-server:sync\n');
  process.exitCode = 1;
} else {
  writeFileSync(path, next);
  process.stdout.write(`MCP server entry: synced ${runner.mcpName}@${runner.version}\n`);
}
