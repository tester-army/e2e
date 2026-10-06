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
  /**
   * One directory per test, `results/<test>/`, holding its trace page
   * (`trace.md`) and its attempts' artifacts (`attempt-<n>/`); the report's
   * artifact paths are relative to it. The members of a serial group keep
   * their pages in their own directories, and their attempts in the group's,
   * named the same way after the group, since one session ran them all. A run
   * clears it when its tests start.
   */
  readonly results: string;
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
    results: path.join(output, 'results'),
    sessions: path.join(output, 'sessions'),
    videos: (sessionId) => path.join(output, 'videos', sessionId),
  };
}
