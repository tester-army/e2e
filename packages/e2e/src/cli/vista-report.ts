/** Reads only the report-1 fields needed to pair Vista checkpoints across runs. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const artifact = z.object({ id: z.string(), kind: z.string(), path: z.string().optional(), redaction: z.string() });
const step = z.object({ api: z.string(), label: z.string(), status: z.string(), artifacts: z.array(z.string()) });
const attempt = z.object({ index: z.number().int(), status: z.string(), steps: z.array(step), artifacts: z.array(artifact) });
const result = z.object({
  testId: z.string(), file: z.string(), titlePath: z.array(z.string()), targetId: z.string(), platform: z.string(),
  agent: z.string(), repeat: z.number().int(), selected: z.boolean(), serialGroupId: z.string().optional(),
  attempts: z.array(attempt),
});
const runPart = z.object({
  results: z.array(result),
  serialGroups: z.array(z.object({
    id: z.string(), attempts: z.array(z.object({
      index: z.number().int(), status: z.string(), artifacts: z.array(artifact),
      members: z.array(z.object({ testId: z.string(), status: z.string(), steps: z.array(step) })),
    })),
  })),
});
const report = z.object({
  schemaVersion: z.literal('report-1'),
  run: runPart.extend({ id: z.string(), carried: runPart.optional() }),
});

/** Semantic identity, independent of declaration order, source lines, and run ids. */
export interface VistaIdentity {
  file: string;
  titlePath: string[];
  target: string;
  platform: string;
  agent: string;
  repeat: number;
  name: string;
  occurrence: number;
}

/** One requested capture in the final attempt, including one that failed. */
export interface VistaCapture {
  identity: VistaIdentity;
  attempt: number;
  attemptStatus: string;
  carried: boolean;
  path?: string;
  unavailable?: string;
}

/** Loads a saved run without executing its config, engines, or test code. */
export async function readVistas(directory: string, target?: string): Promise<{ runId: string; captures: VistaCapture[] }> {
  const parsed = report.safeParse(JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')));
  if (!parsed.success) throw new Error(`Vista: ${directory}/report.json is not a supported report-1 document: ${parsed.error.message}`);
  const { run } = parsed.data;
  const entries = [...run.results.map((entry) => ({ entry, carried: false })),
    ...(run.carried?.results ?? []).map((entry) => ({ entry, carried: true }))];
  if (target !== undefined && !entries.some(({ entry }) => entry.targetId === target)) {
    throw new Error(`Vista: target ${JSON.stringify(target)} is absent from ${directory}`);
  }
  const groups = new Map([...(run.carried?.serialGroups ?? []), ...run.serialGroups].map((group) => [group.id, group]));
  const captures: VistaCapture[] = [];
  for (const { entry, carried } of entries) {
    if (!entry.selected || (target !== undefined && entry.targetId !== target)) continue;
    const groupAttempt = entry.serialGroupId === undefined ? undefined : groups.get(entry.serialGroupId)?.attempts.at(-1);
    const member = groupAttempt?.members.find((item) => item.testId === entry.testId);
    const last = entry.serialGroupId === undefined ? entry.attempts.at(-1) :
      groupAttempt !== undefined && member !== undefined ? { ...groupAttempt, ...member } : undefined;
    if (last === undefined) continue;
    const counts = new Map<string, number>();
    for (const checkpoint of last.steps.filter((item) => item.api === 'app.vista')) {
      const occurrence = (counts.get(checkpoint.label) ?? 0) + 1;
      counts.set(checkpoint.label, occurrence);
      const image = last.artifacts.find((item) => checkpoint.artifacts.includes(item.id) && item.kind === 'screenshot');
      const available = checkpoint.status === 'passed' && image?.redaction === 'complete' && image.path !== undefined;
      captures.push({
        identity: { file: entry.file, titlePath: entry.titlePath, target: entry.targetId, platform: entry.platform,
          agent: entry.agent, repeat: entry.repeat, name: checkpoint.label, occurrence },
        attempt: last.index, attemptStatus: last.status, carried,
        ...(available ? { path: image.path! } : { unavailable: `Checkpoint ${checkpoint.status}; no completed, redacted screenshot` }),
      });
    }
  }
  return { runId: run.id, captures };
}
