import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tesseractOcr } from '../../src/ocr/tesseract.ts';
import type { OcrImage } from '../../src/ocr/types.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

const image: OcrImage = {
  data: readFileSync(new URL('../fixtures/ocr/controls.png', import.meta.url)),
  mediaType: 'image/png',
  width: 640,
  height: 160,
};
const tsv = readFileSync(new URL('../fixtures/ocr/lines.tsv', import.meta.url), 'utf8');
const header = tsv.split('\n')[0]!;
const signal = new AbortController().signal;

/** Supplies native-process streams without launching or depending on Tesseract. */
function processFixture() {
  const input: Buffer[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(() => true),
  });
  child.stdin.on('data', (chunk: Buffer) => input.push(chunk));
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return {
    child,
    input,
    complete(output = tsv, code: number | null = 0) {
      child.stdout.write(output);
      child.emit('close', code, code === null ? 'SIGTERM' : null);
    },
  };
}

beforeEach(() => { vi.mocked(spawn).mockReset(); });

describe('tesseractOcr', () => {
  it('keeps images in stdin, discards native diagnostics, and groups words into bounded lines', async () => {
    const fixture = processFixture();
    const provider = tesseractOcr();
    const pending = provider.recognize(image, { signal });
    fixture.complete();
    expect(provider.name).toBe('tesseract');
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      'tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '11', 'tsv'],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    expect(Buffer.concat(fixture.input)).toEqual(image.data);
    expect(await pending).toEqual([
      { text: 'Sign in', confidence: 0.855, rect: { x: 10, y: 10, width: 70, height: 20 } },
      { text: 'Cancel', confidence: 0.92, rect: { x: 10, y: 55, width: 60, height: 20 } },
      { text: 'Über', confidence: 0.9, rect: { x: 200, y: 10, width: 40, height: 20 } },
      { text: 'Uncertain', confidence: 0, rect: { x: 200, y: 55, width: 80, height: 20 } },
    ]);
    expect(fixture.child.kill).not.toHaveBeenCalled();
    expect(fixture.child.stdin.destroyed).toBe(true);
    expect(fixture.child.stdout.destroyed).toBe(true);
  });

  it('passes custom local configuration as literal arguments before the TSV config', async () => {
    const fixture = processFixture();
    const pending = tesseractOcr({
      executable: '/opt/OCR tools/tesseract;literal',
      language: 'eng+script/Latin',
      tessdata: '/opt/OCR data;literal',
      pageSegmentation: 6,
    }).recognize(image, { signal });
    fixture.complete(`${header}\n`);
    await expect(pending).resolves.toEqual([]);
    expect(spawn).toHaveBeenCalledWith(
      '/opt/OCR tools/tesseract;literal',
      ['stdin', 'stdout', '-l', 'eng+script/Latin', '--psm', '6', '--tessdata-dir', '/opt/OCR data;literal', 'tsv'],
      expect.objectContaining({ shell: false }),
    );
  });

  it.each([
    { executable: '' }, { executable: '\u0000private' }, { executable: '--help' },
    { tessdata: '' }, { tessdata: '/tmp/private\npath' },
    { language: '' }, { language: 'eng --help' }, { language: '../../private' },
    { language: 'eng+' }, { language: 'e'.repeat(257) },
    { pageSegmentation: 0 }, { pageSegmentation: 2 }, { pageSegmentation: 14 },
    { pageSegmentation: 1.5 }, { pageSegmentation: NaN },
  ])('rejects invalid options before starting a process: %j', (options) => {
    expect(() => tesseractOcr(options)).toThrow('Tesseract');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { width: 0 }, { height: -1 }, { width: 1.5 }, { width: 100_000, height: 100_000 },
    { width: 641 }, { data: Buffer.alloc(0) }, { data: Buffer.alloc(33) },
    { data: Buffer.alloc(32 * 1024 * 1024 + 1) },
  ])('rejects invalid images before starting a process: case %#', async (override) => {
    await expect(tesseractOcr().recognize({ ...image, ...override }, { signal })).rejects.toThrow('Tesseract');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('checks PNG signatures and IHDR dimensions, including nonzero byte offsets', async () => {
    const invalid = Buffer.from(image.data);
    invalid.writeUInt32BE(639, 16);
    await expect(tesseractOcr().recognize({ ...image, data: invalid }, { signal })).rejects.toThrow('dimensions');
    expect(spawn).not.toHaveBeenCalled();
    const fixture = processFixture();
    const backing = Buffer.concat([Buffer.alloc(9), image.data, Buffer.alloc(9)]);
    const pending = tesseractOcr().recognize({ ...image, data: backing.subarray(9, -9) }, { signal });
    fixture.complete();
    await expect(pending).resolves.toHaveLength(4);
  });

  it.each([
    ['header', 'sensitive OCR text'],
    ['columns', `${header}\n5\t1\tprivate`],
    ['coordinates', `${header}\n5\t1\t1\t1\t1\t1\t-1\t10\t20\t20\t95\tprivate`],
    ['bounds', `${header}\n5\t1\t1\t1\t1\t1\t639\t10\t20\t20\t95\tprivate`],
    ['dimensions', `${header}\n5\t1\t1\t1\t1\t1\t10\t10\t0\t20\t95\tprivate`],
    ['confidence', `${header}\n5\t1\t1\t1\t1\t1\t10\t10\t20\t20\t101\tprivate`],
    ['negative confidence', `${header}\n5\t1\t1\t1\t1\t1\t10\t10\t20\t20\t-1\tprivate`],
    ['missing confidence', `${header}\n5\t1\t1\t1\t1\t1\t10\t10\t20\t20\t\tprivate`],
    ['line identity', `${header}\n5\t1\t1\t1\t0\t1\t10\t10\t20\t20\t95\tprivate`],
    ['extra image', `${header}\n5\t2\t1\t1\t1\t1\t10\t10\t20\t20\t95\tprivate`],
    ['control characters', `${header}\n5\t1\t1\t1\t1\t1\t10\t10\t20\t20\t95\tprivate\u0000`],
  ])('fails closed on invalid TSV %s without retaining native text', async (_, output) => {
    const fixture = processFixture();
    const pending = tesseractOcr().recognize(image, { signal });
    fixture.complete(output);
    await expect(pending).rejects.toThrow('Tesseract OCR returned invalid TSV output.');
    await expect(pending).rejects.not.toHaveProperty('cause');
  });

  it('decodes UTF-8 only after all chunks arrive and accepts CRLF output', async () => {
    const fixture = processFixture();
    const pending = tesseractOcr().recognize(image, { signal });
    const output = Buffer.from(tsv.replaceAll('\n', '\r\n'));
    const split = output.indexOf(Buffer.from('Über')) + 1;
    fixture.child.stdout.write(output.subarray(0, split));
    fixture.child.stdout.write(output.subarray(split));
    fixture.child.emit('close', 0, null);
    expect((await pending)[2]?.text).toBe('Über');
  });

  it('ignores empty word text and preserves TSV word order instead of sorting coordinates', async () => {
    const fixture = processFixture();
    const pending = tesseractOcr().recognize(image, { signal });
    fixture.complete(`${header}\n${[
      '5\t1\t1\t1\t1\t1\t80\t10\t20\t20\t100\tfirst',
      '5\t1\t1\t1\t1\t2\t20\t10\t30\t20\t90\tsecond',
      '5\t1\t1\t1\t1\t3\t110\t10\t20\t20\t0\t ',
    ].join('\n')}\n`);
    await expect(pending).resolves.toEqual([
      { text: 'first second', confidence: 0.9, rect: { x: 20, y: 10, width: 80, height: 20 } },
    ]);
  });

  it('removes cancellation listeners on success and does not kill completed work', async () => {
    const fixture = processFixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = tesseractOcr().recognize(image, { signal: controller.signal });
    fixture.complete();
    await pending;
    controller.abort();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(fixture.child.kill).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 rather than substituting text', async () => {
    const fixture = processFixture();
    const pending = tesseractOcr().recognize(image, { signal });
    fixture.child.stdout.write(Buffer.from([0xc3, 0x28]));
    fixture.child.emit('close', 0, null);
    await expect(pending).rejects.toThrow('invalid TSV');
  });

  it('bounds stdout and kills the native process when the byte limit is exceeded', async () => {
    const fixture = processFixture();
    const pending = tesseractOcr().recognize(image, { signal });
    fixture.child.stdout.write(Buffer.alloc(8 * 1024 * 1024));
    fixture.child.stdout.write(Buffer.from('x'));
    await expect(pending).rejects.toThrow('8 MiB');
    expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('bounds the number of parsed rows independently of byte size', async () => {
    const fixture = processFixture();
    const pending = tesseractOcr().recognize(image, { signal });
    fixture.complete(`${header}\n${'\n'.repeat(100_000)}`);
    await expect(pending).rejects.toThrow('invalid TSV');
  });

  it('rejects already-aborted work without spawning or exposing the abort reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('private abort reason'));
    await expect(tesseractOcr().recognize(image, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError', message: 'Tesseract OCR was aborted.',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('kills on cancellation, releases listeners, and ignores later native events', async () => {
    const fixture = processFixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = tesseractOcr().recognize(image, { signal: controller.signal });
    controller.abort(new Error('private abort reason'));
    fixture.child.emit('error', new Error('private native diagnostic'));
    fixture.child.emit('close', 1, null);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Tesseract OCR was aborted.' });
    expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('handles cancellation that happens while the process is being spawned', async () => {
    const fixture = processFixture();
    const controller = new AbortController();
    vi.mocked(spawn).mockImplementation(() => {
      controller.abort();
      return fixture.child as unknown as ReturnType<typeof spawn>;
    });
    await expect(tesseractOcr().recognize(image, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fixture.input).toEqual([]);
  });

  it.each([1, null])('sanitizes native exit failures (%s)', async (exitCode) => {
    const fixture = processFixture();
    const pending = tesseractOcr().recognize(image, { signal });
    fixture.complete('private OCR output', exitCode);
    await expect(pending).rejects.toThrow('Tesseract OCR failed. Check the installed language data and input image.');
    await expect(pending).rejects.not.toHaveProperty('cause');
  });

  it('sanitizes asynchronous launch failures such as missing executables', async () => {
    const fixture = processFixture();
    const pending = tesseractOcr().recognize(image, { signal });
    fixture.child.emit('error', Object.assign(new Error('/private/path ENOENT'), { code: 'ENOENT' }));
    await expect(pending).rejects.toThrow('Tesseract OCR could not start. Check the independently installed executable.');
  });

  it('sanitizes synchronous launch failures', async () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error('/private/path'); });
    await expect(tesseractOcr().recognize(image, { signal })).rejects.toThrow('Tesseract OCR could not start.');
  });

  it.each(['stdin', 'stdout'] as const)('handles %s errors without leaking diagnostics or leaving the process alive', async (stream) => {
    const fixture = processFixture();
    const pending = tesseractOcr().recognize(image, { signal });
    fixture.child[stream].emit('error', new Error('private native diagnostic'));
    await expect(pending).rejects.toThrow(stream === 'stdin' ? 'could not read the image' : 'output could not be read');
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it.runIf(process.env.E2E_TESSERACT_SMOKE === '1')('recognizes the original control fixture with installed local Tesseract', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(actual.spawn);
    const boxes = await tesseractOcr().recognize(image, { signal: AbortSignal.timeout(10_000) });
    expect(boxes.map((box) => box.text)).toContain('Continue');
    expect(boxes.map((box) => box.text)).toContain('Cancel');
    expect(boxes.every((box) => box.confidence >= 0.5)).toBe(true);
    for (const box of boxes) {
      expect(box.rect.x).toBeGreaterThanOrEqual(0);
      expect(box.rect.y).toBeGreaterThanOrEqual(0);
      expect(box.rect.x + box.rect.width).toBeLessThanOrEqual(image.width);
      expect(box.rect.y + box.rect.height).toBeLessThanOrEqual(image.height);
    }
  });

  it.runIf(process.env.E2E_TESSERACT_SMOKE === '1')('terminates a real local Tesseract process when recognition is cancelled', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(actual.spawn);
    const controller = new AbortController();
    const pending = tesseractOcr().recognize(image, { signal: controller.signal });
    const child = vi.mocked(spawn).mock.results[0]!.value as ReturnType<typeof spawn>;
    const closed = once(child, 'close');
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    expect(await closed).toEqual([null, 'SIGKILL']);
    expect(child.killed).toBe(true);
  });
});
