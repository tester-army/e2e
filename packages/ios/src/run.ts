/** Running the Mac's command-line tools: `xcrun simctl`, `xcodebuild`. */

import { execFile } from 'node:child_process';
import { InfrastructureError } from 'e2e/engine';

/** Runs a tool and resolves with its stdout. */
export function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
        return;
      }
      // xcodebuild prints compile errors to stdout and only a summary to stderr.
      const errors = stdout.split('\n').filter((line) => line.includes('error:')).slice(0, 20);
      const detail = [...errors, stderr.trim() || error.message].filter((line) => line !== '').join('\n');
      reject(new InfrastructureError('ENGINE_FAILURE', `${command} ${args.join(' ')} failed: ${detail}`));
    });
  });
}
