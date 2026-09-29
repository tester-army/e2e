/** `stopProviderRecording`: a provider's file or link becomes the attempt's segment, and anything else is refused, naming the provider and lease. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isProviderRecording, stopProviderRecording, type ProviderRecording, type ProviderRecordingResult } from '../../src/engine/index.ts';

describe('stopProviderRecording', () => {
  const made: string[] = [];
  let artifactsDir = '';
  const target = () => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-recording-'));
    made.push(artifactsDir);
    return { artifactsDir, provider: 'browser provider "cloud"', leaseId: 'lease-7', signal: new AbortController().signal };
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const recording = (stop: (dir: string) => Promise<unknown>): ProviderRecording => ({
    startedAt: '2026-09-28T10:00:00.000Z',
    stop: async ({ dir }) => (await stop(dir)) as ProviderRecordingResult,
  });

  it('turns a file the provider wrote into the attempt video directory into a file segment', async () => {
    const where = target();
    const segment = await stopProviderRecording(
      recording(async (dir) => {
        writeFileSync(path.join(dir, 'replay.mp4'), 'mp4');
        return { file: 'replay.mp4' };
      }),
      where,
    );
    expect(segment).toEqual({ path: 'video/replay.mp4', startedAt: '2026-09-28T10:00:00.000Z' });
    expect(existsSync(path.join(artifactsDir, 'video', 'replay.mp4'))).toBe(true);
  });

  it('turns an http(s) URL with a media type into a link segment, in the parsed forms the report admits', async () => {
    const segment = await stopProviderRecording(recording(async () => ({ url: 'https://cloud.example/r/7', mediaType: 'text/html' })), target());
    expect(segment).toEqual({ url: 'https://cloud.example/r/7', mediaType: 'text/html', startedAt: '2026-09-28T10:00:00.000Z' });
    const loose: ProviderRecording = { startedAt: '2026-09-28T10:00:00Z', stop: async () => ({ url: ' HTTPS://Cloud.example/r/\u001b]8;;x', mediaType: ' video/mp4 ' }) };
    const normalized = await stopProviderRecording(loose, target());
    expect(normalized).toEqual({ url: 'https://cloud.example/r/%1B]8;;x', mediaType: 'video/mp4', startedAt: '2026-09-28T10:00:00.000Z' });
  });

  it('knows a recording by a parseable start time and a stop', () => {
    expect(isProviderRecording({ startedAt: '2026-09-28T10:00:00Z', stop: async () => ({ file: 'r.mp4' }) })).toBe(true);
    for (const value of [undefined, {}, { startedAt: 'soon', stop: async () => ({}) }, { startedAt: '2026-09-28T10:00:00Z' }]) {
      expect(isProviderRecording(value)).toBe(false);
    }
  });

  it('refuses a file outside the directory or never written, a non-http URL, and a link without a media type', async () => {
    const tooLong = { url: `https://cloud.example/${'r'.repeat(2048)}`, mediaType: 'video/mp4' };
    for (const result of [{ file: '../escape.mp4' }, { file: 'missing.mp4' }, { file: 'nul\0.mp4' }, { url: 'file:///tmp/r.mp4', mediaType: 'video/mp4' }, { url: 'https://', mediaType: 'video/mp4' }, { url: 'https://cloud.example/r' }, tooLong, 'replay.mp4']) {
      await expect(stopProviderRecording(recording(async () => result), target())).rejects.toMatchObject({
        code: 'ENGINE_FAILURE',
        message: expect.stringContaining('browser provider "cloud" recording lease lease-7 finished without naming a file'),
      });
    }
  });

  it('refuses a directory named as the file the provider wrote', async () => {
    const directory = recording(async (dir) => {
      mkdirSync(path.join(dir, 'clip.mp4'));
      return { file: 'clip.mp4' };
    });
    await expect(stopProviderRecording(directory, target())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('names the provider and the lease when the video directory cannot be made', async () => {
    const where = target();
    writeFileSync(path.join(where.artifactsDir, 'video'), 'a file where the directory goes');
    await expect(stopProviderRecording(recording(async () => ({ file: 'replay.mp4' })), where)).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "cloud" recording lease lease-7 has no video directory to write into'),
    });
  });

  it('names the provider and the lease when the stop itself fails', async () => {
    await expect(stopProviderRecording(recording(async () => { throw new Error('502 from the recorder'); }), target())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: 'browser provider "cloud" recording lease lease-7 could not finish: 502 from the recorder',
    });
  });
});
