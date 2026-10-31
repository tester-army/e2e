#!/usr/bin/env node
import { unsupportedRuntimeMessage } from '../internal/node-version.ts';
import { packageVersion } from '../internal/package-version.ts';
import { ignoreBrokenPipes } from './broken-pipe.ts';
import type { DoctorReport } from './doctor.ts';

/** Whether `args` ask for `e2e doctor --reporter json`, which a host parses even when the runtime is refused. */
function wantsDoctorJson(args: readonly string[]): boolean {
  return args[0] === 'doctor' && args.some((arg, index) => arg === '--reporter=json' || (arg === '--reporter' && args[index + 1] === 'json'));
}

// Checked before the CLI module loads: that module and its dependencies are
// what an old runtime would fail on, with a stack trace instead of a sentence.
const unsupported = unsupportedRuntimeMessage();
if (unsupported !== undefined) {
  if (wantsDoctorJson(process.argv.slice(2))) {
    const version = packageVersion(import.meta.url, '../../package.json', '0.0.0');
    const report: DoctorReport = { schemaVersion: 'doctor-1', version, ok: false, checks: [{ id: 'node', status: 'fail', message: unsupported }] };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stderr.write(`${unsupported}\n`);
  }
  process.exit(2);
}

ignoreBrokenPipes([process.stdout, process.stderr]);

const { main } = await import('./index.ts');
await main(process.argv);
const { exitAfterGrace, exitIfStopped } = await import('./run-output.ts');
await exitIfStopped();
exitAfterGrace();
