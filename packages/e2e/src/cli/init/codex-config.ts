import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser';

type Table = AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable;

/** Reads Codex project settings as TOML 1.0. */
export function readCodexConfig(text: string): Record<string, unknown> {
  const document = getStaticTOMLValue(parseTOML(text, { tomlVersion: '1.0' }));
  const servers = document.mcp_servers;
  if (servers !== undefined) {
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers) || servers instanceof Date) {
      throw new Error('mcp_servers must be a TOML table');
    }
    const server = servers.e2e;
    if (server !== undefined && (typeof server !== 'object' || server === null || Array.isArray(server) || server instanceof Date)) {
      throw new Error('mcp_servers.e2e must be a TOML table');
    }
  }
  return document;
}

/** Updates only the launch values, preserving comments, formatting, and other settings. */
export function updateCodexConfig(text: string, entry: { readonly command: string; readonly args: readonly string[] }): string {
  let content = text;
  if (content.trim() === '') content += `${content.endsWith('\n') || content === '' ? '' : '\n'}[mcp_servers.e2e]\n`;
  for (const [key, value] of Object.entries(entry)) {
    content = setLaunchValue(content, ['mcp_servers', 'e2e', key], value);
  }
  readCodexConfig(content);
  return content;
}

/** Replaces a value or inserts a dotted key into its nearest existing table. */
function setLaunchValue(text: string, keys: readonly string[], value: string | readonly string[]): string {
  const root = parseTOML(text, { tomlVersion: '1.0' }).body[0];
  let container = root as Table;
  let depth = 0;
  let existing: AST.TOMLContentNode | undefined;

  /** Finds the value and the deepest table that can hold a missing key. */
  function visit(node: Table, prefix: readonly (string | number)[]): void {
    if (prefix.length > keys.length || !prefix.every((key, index) => key === keys[index])) return;
    if (prefix.length >= depth) {
      container = node;
      depth = prefix.length;
    }
    for (const child of node.body) {
      if (child.type === 'TOMLTable') {
        visit(child, child.resolvedKey);
        continue;
      }
      const resolved = [...prefix, ...getStaticTOMLValue(child.key)];
      if (!resolved.every((key, index) => key === keys[index])) continue;
      if (resolved.length === keys.length) existing = child.value;
      else if (child.value.type === 'TOMLInlineTable') visit(child.value, resolved);
      else throw new Error(`Codex setting ${resolved.join('.')} must be a TOML table`);
    }
  }

  visit(root, []);
  const encoded = JSON.stringify(value);
  if (existing !== undefined) return text.slice(0, existing.range[0]) + encoded + text.slice(existing.range[1]);
  const assignment = `${keys.slice(depth).join('.')} = ${encoded}`;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let offset: number;
  let insertion: string;
  if (container.type === 'TOMLInlineTable') {
    offset = container.range[1] - 1;
    insertion = `${container.body.length > 0 ? ', ' : ''}${assignment}`;
  } else {
    offset = container.type === 'TOMLTable'
      ? text.indexOf('\n', container.key.range[1]) + 1
      : root.body.find((node) => node.type === 'TOMLTable')?.range[0] ?? text.length;
    if (offset === 0) offset = text.length;
    insertion = `${offset > 0 && text[offset - 1] !== '\n' ? newline : ''}${assignment}${newline}`;
  }
  return text.slice(0, offset) + insertion + text.slice(offset);
}
