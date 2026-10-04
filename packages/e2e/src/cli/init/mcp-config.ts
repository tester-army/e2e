/**
 * The `e2e init` step that registers the `e2e mcp` server with the coding
 * agents that read a project-level MCP config file. Each file is JSON with a
 * `mcpServers` map; the entry is merged in and every other server is left
 * exactly as it was.
 */

import path from 'node:path';
import { readIfPresent } from './read-if-present.ts';

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
] as const satisfies readonly McpLocation[];

const MCP_SERVER_NAME = 'e2e';

/** How every client starts the server: the project's own e2e, never a fetched one. */
const SERVER_ENTRY = { command: 'npx', args: ['e2e', 'mcp'] } as const;

export interface McpRegistration {
  /** Project-relative file, e.g. `.mcp.json`. */
  readonly relative: string;
  /** True when the file already existed, so the write is an update. */
  readonly existing: boolean;
  readonly absolute: string;
  readonly content: string;
}

interface McpConfigDocument {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readDocument(absolute: string): { document: McpConfigDocument; text: string } | undefined {
  const text = readIfPresent(absolute);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch (cause) {
    throw new Error(`${absolute} is not valid JSON; fix it or remove it before registering the MCP server`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${absolute} must hold a JSON object with a "mcpServers" map`);
  }
  return { document: parsed as McpConfigDocument, text };
}

/** Known config files that already register the e2e server. */
export function findRegisteredMcpFiles(cwd: string): string[] {
  return MCP_LOCATIONS.map((location) => location.file).filter((file) => {
    try {
      const servers = readDocument(path.join(cwd, file))?.document.mcpServers;
      return typeof servers === 'object' && servers !== null && MCP_SERVER_NAME in servers;
    } catch {
      return false;
    }
  });
}

/**
 * Plans the writes for the given files. A file without the entry gets it
 * merged in; one whose entry already matches needs nothing and is left out.
 * Other servers, other keys, and the file's indentation are preserved.
 */
export function planMcpRegistration(cwd: string, files: readonly string[]): McpRegistration[] {
  const registrations: McpRegistration[] = [];
  for (const file of files) {
    const absolute = path.join(cwd, file);
    const read = readDocument(absolute);
    const document = read?.document ?? {};
    const servers =
      typeof document.mcpServers === 'object' && document.mcpServers !== null && !Array.isArray(document.mcpServers)
        ? document.mcpServers
        : {};
    if (JSON.stringify(servers[MCP_SERVER_NAME]) === JSON.stringify(SERVER_ENTRY)) continue;
    const merged: McpConfigDocument = { ...document, mcpServers: { ...servers, [MCP_SERVER_NAME]: SERVER_ENTRY } };
    const indent = read?.text.match(/\n([\t ]+)"/)?.[1] ?? '  ';
    registrations.push({
      relative: file,
      existing: read !== undefined,
      absolute,
      content: `${JSON.stringify(merged, null, indent)}\n`,
    });
  }
  return registrations;
}
