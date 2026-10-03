/**
 * The built-in evidence reporter: once the run has finished, one sealed
 * `<runId>.evidence` pack beside the report, built from the report and the
 * artifacts it links. Like every reporter it never decides the run: a pack
 * that cannot be written or does not validate is a summary line, and a
 * half-written directory is removed.
 */

import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedEvidence } from '../../config/resolve.ts';
import { sanitizeText } from '../../internal/errors.ts';
import { withAbort } from '../../internal/time.ts';
import { sanitizePathSegment } from '../../run/artifacts.ts';
import type { Reporter, ReporterSummary } from '../../types.ts';
import { planPack } from './map.ts';
import { sealPack } from './seal.ts';
import { writePack } from './write.ts';

/** The reporter that writes the run's pack into `options.outDir`. */
export function evidenceReporter(options: ResolvedEvidence): Reporter {
  return {
    name: 'evidence',
    async onRunFinished(run, signal): Promise<ReporterSummary> {
      // No report was written (the run stopped before its tests, or the write failed): the pack follows the report, and the previous one stays.
      if (run.reportPath === undefined) return [{ label: 'Evidence', text: 'not written: the run wrote no report' }];
      const report = run.report;
      const packDir = path.join(options.outDir, `${sanitizePathSegment(report.run.id)}.evidence`);
      const shown = (file: string): string => path.relative(run.projectRoot, file) || file;
      try {
        // The directory holds the latest run's pack only, as artifacts/ holds the latest run's files.
        await removePacks(options.outDir);
        await writePack(planPack(report), packDir, { artifactsRoot: run.artifactsRoot }, signal);
        signal.throwIfAborted();
        // The seal cannot be interrupted midway; a cancelled reporter stops waiting, and the catch removes the pack.
        const sealed = await withAbort(sealPack(packDir, report.run.finishedAt, options.profile), signal, () => new Error('the run stopped waiting for the pack'));
        const errors = sealed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
        return [
          { label: 'Evidence', text: shown(sealed.sealedPath) },
          ...(sealed.valid
            ? []
            : [{ label: 'Evidence', text: `invalid at ${options.profile}: ${errors.length} error${errors.length === 1 ? '' : 's'}, first ${errors[0]?.code ?? 'unknown'} at ${errors[0]?.location ?? '?'}` }]),
        ];
      } catch (cause) {
        await rm(packDir, { recursive: true, force: true }).catch(() => undefined);
        const reason = cause instanceof Error ? cause.message : String(cause);
        return [{ label: 'Evidence', text: `not written: ${sanitizeText(reason)}` }];
      }
    },
  };
}

/** Removes earlier packs, sealed or left half-written, and nothing else: `outDir` may be shared. */
async function removePacks(outDir: string): Promise<void> {
  const entries = await readdir(outDir).catch(() => [] as string[]);
  await Promise.all(
    entries.filter((name) => /\.evidence(\.(tmp|bak)-[^/]*)?$/.test(name)).map((name) => rm(path.join(outDir, name), { recursive: true, force: true })),
  );
}
