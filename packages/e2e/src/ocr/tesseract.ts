import { spawn } from 'node:child_process';
import type { OcrBox, OcrImage, OcrProvider } from './types.ts';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_ROWS = 100_000;
const TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Local Tesseract configuration; executable and traineddata must already exist. */
export interface TesseractOcrOptions {
  readonly executable?: string;
  readonly language?: string;
  readonly tessdata?: string;
  /** An OCR mode (1 or 3–13); defaults to 11, sparse text. */
  readonly pageSegmentation?: number;
}

/**
 * Recognizes PNGs with an independently installed Tesseract executable and local
 * traineddata. Nothing is downloaded, and images and recognition output stay in
 * memory. Defaults to English and sparse text (PSM 11). Each returned box is a
 * text line whose confidence is the lowest confidence of its constituent words.
 */
export function tesseractOcr(options: TesseractOcrOptions = {}): OcrProvider {
  const executable = options.executable ?? 'tesseract';
  const language = options.language ?? 'eng';
  const pageSegmentation = options.pageSegmentation ?? 11;
  validatePath(executable, 'executable');
  if (
    typeof language !== 'string' || language.length > 256 ||
    !/^[a-zA-Z][a-zA-Z0-9_]*(?:\/[a-zA-Z][a-zA-Z0-9_]*)?(?:\+[a-zA-Z][a-zA-Z0-9_]*(?:\/[a-zA-Z][a-zA-Z0-9_]*)?)*$/.test(language)
  ) {
    throw new Error('Tesseract language must name installed languages or scripts separated by +.');
  }
  if (!Number.isInteger(pageSegmentation) || pageSegmentation < 1 || pageSegmentation > 13 || pageSegmentation === 2) {
    throw new Error('Tesseract pageSegmentation must be an OCR mode: 1 or 3 through 13.');
  }
  const args = ['stdin', 'stdout', '-l', language, '--psm', String(pageSegmentation)];
  if (options.tessdata !== undefined) {
    validatePath(options.tessdata, 'tessdata');
    args.push('--tessdata-dir', options.tessdata);
  }
  args.push('tsv');
  return {
    name: 'tesseract',
    async recognize(image, { signal }) {
      if (signal.aborted) throw aborted();
      validateImage(image);
      return recognize(executable, args, image, signal);
    },
  };
}

/** Rejects malformed configuration without echoing a potentially private path. */
function validatePath(value: string, option: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || hasControls(value) || value.startsWith('-')) {
    throw new Error(`Tesseract ${option} must be a nonempty local path or executable name.`);
  }
}

/** Rejects control bytes without including untrusted content in diagnostics. */
function hasControls(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Bounds input before the native decoder runs and checks the declared dimensions. */
function validateImage(image: OcrImage): void {
  if (
    image.mediaType !== 'image/png' || !(image.data instanceof Uint8Array) ||
    image.data.byteLength < 33 || image.data.byteLength > MAX_IMAGE_BYTES ||
    !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
    image.width < 1 || image.height < 1 || image.width * image.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('Tesseract requires a PNG of at most 32 MiB and 32 million pixels.');
  }
  const data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  if (
    !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.readUInt32BE(8) !== 13 ||
    data.toString('ascii', 12, 16) !== 'IHDR' ||
    data.readUInt32BE(16) !== image.width || data.readUInt32BE(20) !== image.height
  ) {
    throw new Error('Tesseract PNG dimensions must match the image dimensions.');
  }
}

/** Runs one cancellable native process without a shell or temporary image files. */
function recognize(executable: string, args: readonly string[], image: OcrImage, signal: AbortSignal): Promise<readonly OcrBox[]> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      reject(new Error('Tesseract OCR could not start. Check the independently installed executable.'));
      return;
    }
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    /** Releases input/output buffers and cancellation listeners for every exit path. */
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      child.stdin.destroy();
      child.stdout.destroy();
      chunks.length = 0;
    };
    /** Stops the process on failures without exposing native diagnostics or input. */
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      cleanup();
      reject(error);
    };
    /** Ignores the signal reason because it may contain private recognition data. */
    const onAbort = (): void => fail(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', () => fail(new Error('Tesseract OCR could not start. Check the independently installed executable.')));
    child.stdin.on('error', () => fail(new Error('Tesseract OCR could not read the image.')));
    child.stdout.on('error', () => fail(new Error('Tesseract OCR output could not be read.')));
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail(new Error('Tesseract OCR output exceeded the 8 MiB limit.'));
        return;
      }
      chunks.push(chunk);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (signal.aborted) {
        onAbort();
        return;
      }
      if (code !== 0) {
        fail(new Error('Tesseract OCR failed. Check the installed language data and input image.'));
        return;
      }
      let boxes: readonly OcrBox[];
      try {
        const output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, outputBytes));
        boxes = parseTsv(output, image);
      } catch {
        fail(new Error('Tesseract OCR returned invalid TSV output.'));
        return;
      }
      settled = true;
      cleanup();
      resolve(boxes);
    });
    if (signal.aborted) {
      onAbort();
      return;
    }
    child.stdin.end(image.data);
  });
}

/** Makes cancellation safe to report even when the supplied abort reason is private. */
function aborted(): Error {
  const error = new Error('Tesseract OCR was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Validates TSV word geometry and combines words using Tesseract's line identities. */
function parseTsv(output: string, image: OcrImage): readonly OcrBox[] {
  const rows = output.split(/\r?\n/);
  if (rows[0] !== TSV_HEADER || rows.length > MAX_OUTPUT_ROWS) throw new Error('Invalid TSV.');
  const lines = new Map<string, { words: string[]; confidence: number; x: number; y: number; right: number; bottom: number }>();
  for (const row of rows.slice(1)) {
    if (row === '') continue;
    const fields = row.split('\t');
    if (fields.length !== 12) throw new Error('Invalid TSV.');
    const values = fields.slice(0, 10).map((field) => /^\d+$/.test(field) ? Number(field) : NaN);
    if (!values.every(Number.isSafeInteger)) throw new Error('Invalid TSV.');
    const [level, sheet, block, paragraph, line, word, x, y, width, height] = values as [number, number, number, number, number, number, number, number, number, number];
    if (level < 1 || level > 5 || sheet !== 1 || x + width > image.width || y + height > image.height) {
      throw new Error('Invalid TSV.');
    }
    if (level !== 5) continue;
    const confidenceText = fields[10]!;
    const confidence = /^\d+(?:\.\d+)?$/.test(confidenceText) ? Number(confidenceText) : NaN;
    if (block < 1 || paragraph < 1 || line < 1 || word < 1 || width < 1 || height < 1 || !Number.isFinite(confidence) || confidence > 100) {
      throw new Error('Invalid TSV.');
    }
    const text = fields[11]!.trim();
    if (!text) continue;
    if (hasControls(text)) throw new Error('Invalid TSV.');
    const key = `${sheet}:${block}:${paragraph}:${line}`;
    const previous = lines.get(key);
    if (previous) {
      previous.words.push(text);
      previous.confidence = Math.min(previous.confidence, confidence / 100);
      previous.x = Math.min(previous.x, x);
      previous.y = Math.min(previous.y, y);
      previous.right = Math.max(previous.right, x + width);
      previous.bottom = Math.max(previous.bottom, y + height);
    } else {
      lines.set(key, { words: [text], confidence: confidence / 100, x, y, right: x + width, bottom: y + height });
    }
  }
  return [...lines.values()].map((line) => ({
    text: line.words.join(' '),
    confidence: line.confidence,
    rect: { x: line.x, y: line.y, width: line.right - line.x, height: line.bottom - line.y },
  }));
}
