/**
 * The layout of the output directory (`output`, `--output`): every result a
 * run, an exploration, or an `e2e mcp` session writes lives at a fixed name
 * under it, so nothing derives one location from another.
 */

import path from 'node:path';

export interface OutputLayout {
  /** The canonical `report.json`; the file reporters write beside it too (`junit.xml`, `summary.md`). */
  readonly report: string;
  /** The `--ai-trace` recording, `ai-trace.json`. */
  readonly aiTrace: string;
  /** One markdown page per failed or flaky test, `failures/`; a run empties it when it writes the report. */
  readonly failures: string;
  /** The artifact tree the report's paths are relative to; a run clears it when it starts. */
  readonly artifacts: string;
  /** The per-run encrypted session stores. */
  readonly sessions: string;
  /** Where `e2e mcp` saves one session's recordings. */
  readonly videos: (sessionId: string) => string;
}

/** The fixed paths under the absolute output directory `output`. */
export function outputLayout(output: string): OutputLayout {
  return {
    report: path.join(output, 'report.json'),
    aiTrace: path.join(output, 'ai-trace.json'),
    failures: path.join(output, 'failures'),
    artifacts: path.join(output, 'artifacts'),
    sessions: path.join(output, 'sessions'),
    videos: (sessionId) => path.join(output, 'videos', sessionId),
  };
}
