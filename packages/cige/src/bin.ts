#!/usr/bin/env node
import { main } from './cli.ts';

// A reader that stops early (`e2e-cige check --json | head -1`) closes the pipe; drop EPIPE, as `e2e` does.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

process.exitCode = await main(process.argv.slice(2));
