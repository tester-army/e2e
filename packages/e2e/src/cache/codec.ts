import { emitReplayCode, readReplayCode } from './code.ts';
import { buildTraceEntry, type ActionTrace, type TraceEntry } from './trace.ts';
import { readTraceEntry } from './trace-read.ts';
import { canonicalJson } from '../internal/ids.ts';

export type CacheFormat = 'json' | 'code';

interface CacheCodec {
  readonly extension: string;
  decode(source: string): TraceEntry | undefined;
  encode(payload: ActionTrace): string;
}

/** The only format-specific serialization and naming rules used by file stores. */
export const CACHE_CODECS: Readonly<Record<CacheFormat, CacheCodec>> = {
  json: {
    extension: '.json',
    decode: (source) => readTraceEntry(JSON.parse(source)),
    encode: (payload) => `${JSON.stringify(buildTraceEntry(payload), null, 2)}\n`,
  },
  code: {
    extension: '.replay.ts',
    decode: readReplayCode,
    encode: (payload) => {
      const expected = readTraceEntry(buildTraceEntry(payload));
      if (expected === undefined) throw new Error('cannot encode an invalid recording');
      const source = emitReplayCode(expected.payload);
      if (canonicalJson(readReplayCode(source).payload) !== canonicalJson(expected.payload)) throw new Error('code recording failed round-trip validation');
      return source;
    },
  },
};

/** Names an entry consistently in the store, diagnostics and trace pages. */
export function cacheFileName(keyHash: string, format: CacheFormat = 'json'): string {
  return `${keyHash}${CACHE_CODECS[format].extension}`;
}

/** Recognizes only a digest-named entry, never a path or a sidecar. */
export function cacheFileIdentity(name: string): { keyHash: string; format: CacheFormat } | undefined {
  for (const format of ['json', 'code'] as const) {
    const extension = CACHE_CODECS[format].extension;
    const keyHash = name.endsWith(extension) ? name.slice(0, -extension.length) : '';
    if (/^[a-f0-9]{64}$/u.test(keyHash)) return { keyHash, format };
  }
  return undefined;
}
