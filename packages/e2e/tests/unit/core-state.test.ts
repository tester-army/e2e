/** `e2e-core`'s `SessionState`: encrypted export, authenticated import, and the host it restores on. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { restoredStateFor, SessionState } from 'e2e-core/lib/core/state';

const identity = { engine: 'web', platform: 'web', appIdentity: 'a'.repeat(64) };
const key = new Uint8Array(32).fill(1);
const captured = (expiresAt?: string) =>
  SessionState.captured(identity, { format: 'storage', version: 1, data: { cookies: [{ name: 'sid', value: 'cookie-value' }] }, ...(expiresAt === undefined ? {} : { expiresAt }) }, [['token', 'provider-token-value']]);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('SessionState', () => {
  it('exports a session-state-1 document that names the host in the clear and holds nothing else readable', async () => {
    const bytes = await captured('2099-01-01T00:00:00Z').export({ key });
    const schema = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'schema', 'session-state-v1.schema.json'), 'utf8')) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats.default(ajv);
    const validate = ajv.compile(schema);
    const document = JSON.parse(text(bytes)) as Record<string, unknown>;
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect(document).toMatchObject({ engine: 'web', platform: 'web', expiresAt: '2099-01-01T00:00:00.000Z', secrecy: { names: ['token'] } });
    expect(text(bytes)).not.toContain('cookie-value');
    expect(text(bytes)).not.toContain('provider-token-value');
  });

  it('round-trips under the same key and restores on a matching host', async () => {
    const restored = await SessionState.import(await captured().export({ key }), { key });
    expect(restored.engine).toBe('web');
    expect(restoredStateFor(restored, identity)).toEqual({
      state: { format: 'storage', version: 1, data: { cookies: [{ name: 'sid', value: 'cookie-value' }] } },
      secrets: [['token', 'provider-token-value']],
    });
  });

  it('refuses another key, an edited document, and something that is not one as SESSION_INVALID', async () => {
    const bytes = await captured().export({ key });
    await expect(SessionState.import(bytes, { key: new Uint8Array(32).fill(2) })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    const edited = JSON.parse(text(bytes)) as { platform: string };
    edited.platform = 'ios';
    await expect(SessionState.import(new TextEncoder().encode(JSON.stringify(edited)), { key })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await expect(SessionState.import(new TextEncoder().encode('{}'), { key })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await expect(SessionState.import(new TextEncoder().encode('not json'), { key })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    for (const field of ['iv', 'tag'] as const) {
      const malformed = JSON.parse(text(bytes)) as { state: Record<string, string> };
      malformed.state[field] = '';
      await expect(SessionState.import(new TextEncoder().encode(JSON.stringify(malformed)), { key }), field).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    }
  });

  it('takes a 32-byte key only', async () => {
    await expect(captured().export({ key: new Uint8Array(31) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(captured().export({ key: 'secret' as never })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('refuses an expired state, and restores only on the engine, platform, and app it was captured on', async () => {
    const expired = captured('2001-01-01T00:00:00.000Z');
    await expect(SessionState.import(await expired.export({ key }), { key })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(() => restoredStateFor(expired, identity)).toThrow(expect.objectContaining({ code: 'SESSION_EXPIRED' }));
    expect(() => restoredStateFor(captured(), { ...identity, appIdentity: 'b'.repeat(64) })).toThrow(expect.objectContaining({ code: 'SESSION_MISMATCH' }));
    expect(() => restoredStateFor(captured(), { ...identity, engine: 'mobile' })).toThrow(expect.objectContaining({ code: 'SESSION_MISMATCH' }));
    expect(() => restoredStateFor({ engine: 'web', platform: 'web' }, identity)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
