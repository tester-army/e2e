#!/usr/bin/env node
import { unsupportedRuntimeMessage } from '../internal/node-version.ts';
import { ignoreBrokenPipes } from './broken-pipe.ts';

// Checked before the CLI module loads: that module and its dependencies are
// what an old runtime would fail on, with a stack trace instead of a sentence.
const unsupported = unsupportedRuntimeMessage();
if (unsupported !== undefined) {
  process.stderr.write(`${unsupported}\n`);
  process.exit(2);
}

ignoreBrokenPipes([process.stdout, process.stderr]);

const { main } = await import('./index.ts');
await main(process.argv);
const { exitIfStopped } = await import('./run-output.ts');
await exitIfStopped();
