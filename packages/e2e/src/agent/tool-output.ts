/**
 * The bound on what a project tool may hand the model in one result. A tool
 * that returns a whole log or API payload would otherwise put it in the
 * transcript for every later turn of the step. Two limits apply, lines and
 * bytes, whichever is reached first; the cut never splits a line, and the
 * notice says exactly how much was left out, so the model can ask for a
 * narrower result instead of guessing at what it did not see.
 */

/** Lines a tool result keeps. */
export const MAX_TOOL_OUTPUT_LINES = 400;

/** Bytes a tool result keeps; screens are bounded separately by the observation budget. */
export const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;

export interface BoundToolOutput {
  readonly text: string;
  readonly truncated: boolean;
  /** Which limit cut the output; undefined when it fit. */
  readonly by?: 'lines' | 'bytes';
  readonly totalLines: number;
  readonly totalBytes: number;
}

/** Cuts a tool result to the limits, on a line boundary, with a notice naming what is missing. */
export function boundToolOutput(text: string, limits = { maxLines: MAX_TOOL_OUTPUT_LINES, maxBytes: MAX_TOOL_OUTPUT_BYTES }): BoundToolOutput {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  const lines = text.split('\n');
  const totalLines = lines.length;
  if (totalLines <= limits.maxLines && totalBytes <= limits.maxBytes) {
    return { text, truncated: false, totalLines, totalBytes };
  }
  const kept: string[] = [];
  let bytes = 0;
  let by: 'lines' | 'bytes' = 'lines';
  for (const line of lines) {
    if (kept.length >= limits.maxLines) break;
    const lineBytes = Buffer.byteLength(line, 'utf8') + (kept.length === 0 ? 0 : 1);
    if (bytes + lineBytes > limits.maxBytes) {
      by = 'bytes';
      break;
    }
    kept.push(line);
    bytes += lineBytes;
  }
  // A first line longer than the whole byte budget keeps nothing of the text;
  // its head is better than an empty result, and the notice still says so.
  if (kept.length === 0) {
    const head = Buffer.from(text, 'utf8').subarray(0, limits.maxBytes).toString('utf8').replace(/�+$/u, '');
    kept.push(head);
    bytes = Buffer.byteLength(head, 'utf8');
  }
  const notice = `[tool output truncated: showing ${String(kept.length)} of ${String(totalLines)} lines, ${formatBytes(bytes)} of ${formatBytes(totalBytes)}; the ${by} limit was reached. Ask for a narrower result if you need the rest.]`;
  return { text: `${kept.join('\n')}\n${notice}`, truncated: true, by, totalLines, totalBytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
