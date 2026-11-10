/**
 * Files the agent can always attach to a file input, named `sample:<name>`.
 * A project rarely keeps files the model could know to name, so without
 * these an exploration skips every upload flow it meets. They are e2e's own
 * bytes, written once per process to a temporary directory: naming one reads
 * nothing of the project or the machine.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** What an upload path starts with to name a sample instead of a project file. */
export const SAMPLE_PREFIX = 'sample:';

/** A 32 by 32 PNG of four colored squares. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAOklEQVR42mO45+NAEnLruUMSYhi1YNSCUQtGLRi1YEhYELAlhST04YQNSWjUglELRi0YtWDUgiFhAQCR4HRb8WkrnwAAAABJRU5ErkJggg==';

/** The same picture as a baseline JPEG, without metadata. */
const JPEG =
  '/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAAgACADAREAAhEBAxEB/9sAQwAFAwQEBAMFBAQEBQUFBgcMCAcHBwcPCwsJDBEPEhIRDxERExYcFxMUGhURERghGBodHR8fHxMXIiQiHiQcHh8e/9sAQwEFBQUHBgcOCAgOHhQRFB4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4e/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDPr40/dgoA0K/oU/kYKAM+v56P65CgDQr+hT+RgoA1a/ByQoA9Yr8pP3cKAPJ6/Vj8ICgD1ivyk/dwoA//2Q==';

/** A one-page PDF reading "e2e sample document", its cross-reference table counted from the objects. */
function pdf(): Uint8Array {
  const text = 'BT /F1 24 Tf 72 720 Td (e2e sample document) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(text.length)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const table = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const size = String(objects.length + 1);
  body += `xref\n0 ${size}\n0000000000 65535 f \n${table}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${String(body.length)}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** Every sample's bytes by name. */
const SAMPLES: ReadonlyMap<string, () => Uint8Array> = new Map([
  ['photo.png', () => Buffer.from(PNG, 'base64')],
  ['photo.jpg', () => Buffer.from(JPEG, 'base64')],
  ['document.pdf', pdf],
  ['notes.txt', () => new TextEncoder().encode('e2e sample text\nSecond line: café, 東京, 🙂\n')],
  ['table.csv', () => new TextEncoder().encode('name,email,amount\nAda Lovelace,ada@example.test,42\n"Hopper, Grace",grace@example.test,7.5\nZoë Ångström,zoe@example.test,0\n')],
  ['empty.txt', () => new Uint8Array()],
]);

/** The samples' names, as an upload names them after `SAMPLE_PREFIX`. */
export const SAMPLE_NAMES: readonly string[] = [...SAMPLES.keys()];

/** The directory this process wrote the samples to, once one was asked for. */
let directory: string | undefined;

/**
 * Where the named sample is on disk, written on first use and removed when
 * the process exits; undefined for a name that is no sample.
 */
export function samplePath(name: string): string | undefined {
  if (!SAMPLES.has(name)) return undefined;
  if (directory === undefined) {
    const created = mkdtempSync(path.join(tmpdir(), 'e2e-samples-'));
    for (const [file, bytes] of SAMPLES) writeFileSync(path.join(created, file), bytes());
    process.once('exit', () => rmSync(created, { recursive: true, force: true }));
    directory = created;
  }
  return path.join(directory, name);
}
