/**
 * Serves the step tools to the agent as one MCP server over streamable HTTP
 * on 127.0.0.1. An ACP agent takes tools only as MCP servers, and a stdio
 * server would run in another process, away from the step's context; over
 * HTTP every call runs here, in the test worker. The port is ephemeral and
 * the path random per session, so nothing else on the machine guesses it.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/** The MCP server name the agent sees. Distinct from `e2e mcp`'s `e2e`, so a permission request naming it is about these tools. */
export const MCP_SERVER_NAME = 'e2e_step';

/** What a tool answers: text, with a screenshot once the step shows pixels. */
export interface ToolResult {
  readonly text: string;
  /** A base64 image. */
  readonly image?: { readonly data: string; readonly mimeType: string };
  readonly isError?: boolean;
}

/** One tool the agent can call: a closed input schema and its handler. */
export interface ServedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly readOnly: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

/** A running tool server. */
export interface ToolServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Starts the tool server on an ephemeral 127.0.0.1 port. */
export async function serveTools(tools: readonly ServedTool[]): Promise<ToolServer> {
  const route = `/${randomUUID()}/mcp`;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: MCP_SERVER_NAME, version: '1' }, { capabilities: { tools: {} } });
      for (const tool of tools) {
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
          },
          async (args: Record<string, unknown>) => {
            const result = await tool.run(args);
            return {
              content: [
                { type: 'text' as const, text: result.text },
                ...(result.image === undefined ? [] : [{ type: 'image' as const, ...result.image }]),
              ],
              ...(result.isError === true ? { isError: true } : {}),
            };
          },
        );
      }
      return server;
    },
  );
  const http = createServer((request, response) => {
    if (request.url !== route) {
      response.writeHead(404).end();
      return;
    }
    void forward(handler.fetch, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${route}`,
    close: async () => {
      await handler.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Hands one Node request to the web-standard handler and streams its response back. */
async function forward(
  fetch: (request: Request) => Promise<Response>,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    }
    const method = incoming.method ?? 'GET';
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readAll(incoming);
    const response = await fetch(
      new Request(`http://127.0.0.1${incoming.url ?? '/'}`, { method, headers, ...(body === undefined ? {} : { body }) }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) outgoing.end();
    else Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(outgoing);
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end(error instanceof Error ? error.message : String(error));
  }
}

async function readAll(stream: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}
