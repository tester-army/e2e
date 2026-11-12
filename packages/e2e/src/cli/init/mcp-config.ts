/**
 * The `e2e init` step that registers the `e2e mcp` server with the coding
 * agents that read a project-level MCP config file. JSON clients use a
 * `mcpServers` map; Codex uses TOML. Every other server is left
 * exactly as it was. A file reached through a symlink, or under a linked
 * directory, is never read or written through: init reports the link and
 * skips it.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PackageManager } from '../../internal/package-manager.ts';
import { realpathOfExisting } from '../../internal/paths.ts';
import { readCodexConfig, updateCodexConfig } from './codex-config.ts';

interface McpLocation {
  /** Project-relative config file with `/` separators. */
  readonly file: string;
  /** The agents that read it, shown as the prompt hint. */
  readonly hint: string;
}

/** Where project-scoped MCP servers are declared. */
export const MCP_LOCATIONS = [
  { file: '.mcp.json', hint: 'Claude Code' },
  { file: '.cursor/mcp.json', hint: 'Cursor' },
  { file: '.codex/config.toml', hint: 'Codex' },
] as const satisfies readonly McpLocation[];

const MCP_SERVER_NAME = 'e2e';

export interface McpRegistration {
  /** Project-relative file, e.g. `.mcp.json`. */
  readonly relative: string;
  /** True when the file already existed, so the write is an update. */
  readonly existing: boolean;
  readonly absolute: string;
  readonly content: string;
}

/** A symlink on the way to a config file, each once: a file or a directory init will not write through. */
export interface McpLink {
  /** Project-relative path of the link with `/` separators, e.g. `.cursor`. */
  readonly relative: string;
  /** Absolute path the link leads to; the path as written when it dangles. */
  readonly target: string;
}

/** What init plans for the chosen config files: the writes, and the links it leaves alone. */
export interface McpPlan {
  readonly registrations: readonly McpRegistration[];
  readonly links: readonly McpLink[];
}

interface McpConfigDocument {
  mcpServers?: Record<string, unknown>;
  mcp_servers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readDocument(absolute: string): McpConfigDocument | undefined {
  if (!existsSync(absolute)) return undefined;
  const text = readFileSync(absolute, 'utf8');
  let parsed: unknown;
  const toml = absolute.endsWith('.toml');
  try {
    parsed = toml ? readCodexConfig(text) : text.trim() === '' ? {} : JSON.parse(text);
  } catch (cause) {
    throw new Error(`${absolute} is not valid ${toml ? 'TOML' : 'JSON'}; fix it or remove it before registering the MCP server`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${absolute} must hold a JSON object with a "mcpServers" map`);
  }
  return parsed as McpConfigDocument;
}

/**
 * The first symlink between the project root and `target`, or undefined when
 * every existing component is a plain entry. A component past the link is not
 * inspected: it lives wherever the link points.
 */
export function linkOnPath(cwd: string, target: string): McpLink | undefined {
  let current = cwd;
  for (const segment of path.relative(cwd, target).split(path.sep)) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = lstatSync(current);
    } catch {
      return undefined;
    }
    if (entry.isSymbolicLink()) {
      return { relative: path.relative(cwd, current).split(path.sep).join('/'), target: realpathOfExisting(current) };
    }
  }
  return undefined;
}

/** Known config files that already register the e2e server. A file reached through a symlink is not read. */
export function findRegisteredMcpFiles(cwd: string): string[] {
  return MCP_LOCATIONS.map((location) => location.file).filter((file) => {
    if (linkOnPath(cwd, path.join(cwd, file)) !== undefined) return false;
    try {
      const document = readDocument(path.join(cwd, file));
      const servers = file.endsWith('.toml') ? document?.mcp_servers : document?.mcpServers;
      return typeof servers === 'object' && servers !== null && MCP_SERVER_NAME in servers;
    } catch {
      return false;
    }
  });
}

/**
 * Plans the writes for the given files. A file without the entry gets it
 * merged in; one whose entry already matches needs nothing and is left out.
 * Extra settings on the e2e entry, other servers, other keys, and the file's
 * indentation are preserved. A file reached through a symlink is never read;
 * it is returned among `links` for the caller to report and skip.
 */
export function planMcpRegistration(cwd: string, files: readonly string[], manager: PackageManager): McpPlan {
  // How clients start the server from the project with e2e installed; a Bun project may have no Node.js, so no npx.
  const launch = { command: manager === 'bun' ? 'bunx' : 'npx', args: ['e2e', 'mcp'] };
  const registrations: McpRegistration[] = [];
  const links: McpLink[] = [];
  for (const file of files) {
    const link = linkOnPath(cwd, path.join(cwd, file));
    if (link !== undefined) {
      links.push(link);
      continue;
    }
    const absolute = path.join(cwd, file);
    const document = readDocument(absolute) ?? {};
    const serverKey = file.endsWith('.toml') ? 'mcp_servers' : 'mcpServers';
    const servers =
      typeof document[serverKey] === 'object' && document[serverKey] !== null && !Array.isArray(document[serverKey])
        ? document[serverKey]
        : {};
    const existing = servers[MCP_SERVER_NAME];
    const entry = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...existing, ...launch }
      : launch;
    if (JSON.stringify(existing) === JSON.stringify(entry)) continue;
    const merged: McpConfigDocument = { ...document, mcpServers: { ...servers, [MCP_SERVER_NAME]: entry } };
    const original = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
    const indent = original?.match(/\n([\t ]+)"/)?.[1] ?? '  ';
    registrations.push({
      relative: file,
      existing: original !== undefined,
      absolute,
      content: file.endsWith('.toml') ? updateCodexConfig(original ?? '', launch) : `${JSON.stringify(merged, null, indent)}\n`,
    });
  }
  return { registrations, links };
}
