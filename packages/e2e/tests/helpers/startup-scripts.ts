import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Scripts a fixture project starts as app processes, each appending to
 * `startup.log` so a test reads what started and in which order:
 * `server.cjs <port>` logs `app` and serves `ready`, `service.cjs <name>`
 * logs its name and exits.
 */
export const STARTUP_SCRIPTS = {
  'service.cjs': `require('node:fs').appendFileSync('startup.log', process.argv[2] + '\\n');`,
  'server.cjs': `require('node:fs').appendFileSync('startup.log', 'app\\n');
require('node:http').createServer((_request, response) => response.end('ready'))
  .listen(Number(process.argv[2]), '127.0.0.1');`,
} as const;

/** Writes `STARTUP_SCRIPTS` into `dir`. */
export function writeStartupScripts(dir: string): void {
  for (const [name, source] of Object.entries(STARTUP_SCRIPTS)) writeFileSync(path.join(dir, name), source);
}

/** What the startup scripts logged in `dir`, one line each. */
export function startupLog(dir: string): string {
  return readFileSync(path.join(dir, 'startup.log'), 'utf8');
}
