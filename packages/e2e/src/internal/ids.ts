import { createHash, randomBytes } from 'node:crypto';

/**
 * Percent-encodes one title per 11-lifecycle.md: RFC 3986 unreserved characters
 * stay literal, every other UTF-8 byte becomes uppercase %HH.
 */
export function encodeTitle(title: string): string {
  const normalized = title.normalize('NFC');
  const bytes = new TextEncoder().encode(normalized);
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      ch === '-' ||
      ch === '.' ||
      ch === '_' ||
      ch === '~'
    ) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** Validates one raw title per 11-lifecycle.md (1..512 UTF-8 bytes after NFC, no NUL). */
export function validateTitle(title: string): string | null {
  const normalized = title.normalize('NFC');
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (bytes < 1 || bytes > 512) {
    return `title must be 1 through 512 UTF-8 bytes after NFC, got ${bytes}`;
  }
  if (normalized.includes('\u0000')) return 'title must not contain NUL';
  return null;
}

/** Builds a stable test ID: `<normalized-relative-file>::<encoded-title-path>`. */
export function testId(relativeFile: string, titlePath: readonly string[]): string {
  return `${relativeFile}::${titlePath.map(encodeTitle).join('::')}`;
}

/**
 * Canonical collision-free map key for a title path. Joins with NUL, which
 * `validateTitle` forbids inside titles, so distinct paths never collide.
 */
export function titlePathKey(titlePath: readonly string[]): string {
  return titlePath.join('\u0000');
}

/** Builds a setup-test ID: `setup::<test-id>`. */
export function setupTestId(relativeFile: string, titlePath: readonly string[]): string {
  return `setup::${testId(relativeFile, titlePath)}`;
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * RFC 8785 (JCS) canonical JSON serialization for JSON-safe values.
 * Numbers must be finite; non-JSON values throw.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new TypeError('non-finite number in canonical JSON');
      return JSON.stringify(value);
    }
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .toSorted(([a], [b]) => compareUtf16(a, b));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`value of type ${typeof value} is not JSON-safe`);
  }
}

function compareUtf16(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** SHA-256 over the RFC 8785 canonical form, lowercase hex. */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Result ID per 13-reporting.md: SHA-256/JCS of `{ testId, targetId }`. */
export function resultId(test: string, targetId: string): string {
  return canonicalDigest({ testId: test, targetId });
}

/** Generates one lowercase UUIDv7 string. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** RFC 3339 UTC timestamp with exactly millisecond precision. */
export function timestamp(date: Date = new Date()): string {
  return date.toISOString();
}
