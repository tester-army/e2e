import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { web } from '@e2e-dev/web';
import { list } from 'e2e/runner';
import { describe, expect, it } from 'vitest';
import { decisionFilter } from '../src/index.ts';
import { changedRepo, scriptedJudge } from './filter-helpers.ts';

/** The lines between a private key's armor. Each starts with a letter, so git names the one before a hunk in its header. */
const KEY_BODY = [
  'xKeHYQKKYmUIHQUvbL7GD750SXH0WBXc6bbXLt4bdV+uXZqRUz1eI+aY1ScVJc4y',
  'S6zifhBTNEGyB9oJAIa5tz5ysBf2KeiKJ1IxTX6NM2iy1MHdiiYASaEWsgczEERc',
  'CWRxVgjsPQIi0i7ipQkTw1bSSj4Do4fN7oK0dM7aV0UZ3IosvqejGgi0wtS4bsLc',
  'QHN92o+8A0UKM07rsb0kHw2Suae36glwK36DxlsIv39zIMH0aLER07vcp+OiAcj2',
  'aQCHBjMz16MMVuDQzZ1+166hj0dCWD2MeZCwLloc47gzHBRUwHkP+oB+lLyXpidZ',
  'blFibO92Ojru4SBe+OEPfbHKIJPryDHzjrvzYQjinZFkucTuly6LC1cneD4VcDzv',
  'BzLNjY5dbqYqnR3kQBIpzHRecSOGnAssaJ1F+vu7jVgw3CJqfCJu+ZY9AgKppO5j',
  'kQX47iWXWqzd7zhnnjRe1IBALJBm6RImI9lr9dMimYrSsXDidKRTBJpNlo7eLwSF',
  'f4dOHnruzxiTOpVjARdbXrRLWhNaUYUj1ZW1dvLqOg+uts0fUl6+A1BKzO0twks+',
  'dMDEh1aTEWM5zuShco2ysKT+ANbjlP+P7G9eNIXrKOyG54T2fdLQcNOey0x7Cg0B',
  'LvkmGVJZiDkdXe13oRS74SiFvpn9XFQw3KVCRYDne548wO+GTggdu1gX9DGbJEIZ',
  'OW8s0NfAcDDnCZAWm4MQhgiEb4wCgxPmKZNepNzsDl8cQYQaaecnLAb9AuFFkuug',
];
/** A 14-line private key, configured as a secret. */
const PRIVATE_KEY = ['-----BEGIN PRIVATE KEY-----', ...KEY_BODY, '-----END PRIVATE KEY-----'].join('\n');
/** The line a commit writes in place of the key's seventh body line. It shares no 8 characters with the key, so the model reads it. */
const ROTATED_LINE = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKQ';

describe('decisionFilter through e2e/runner', () => {
  it("sends no line of a configured private key when commits edit the line after it or one in its middle, the diff's context lines and hunk headers included", async () => {
    const repo = changedRepo(
      {
        'tests/login.e2e.ts': "import { test } from 'e2e';\ntest('signs in', async () => {});\n",
        'src/after.ts': `export const key = \`${PRIVATE_KEY}\`;\nexport const rotated = 1;\n`,
        'src/middle.ts': `export const key = \`${PRIVATE_KEY}\`;\n`,
      },
      {
        'src/after.ts': `export const key = \`${PRIVATE_KEY}\`;\nexport const rotated = 2;\n`,
        'src/middle.ts': `export const key = \`${PRIVATE_KEY.replace(KEY_BODY[6] ?? '', ROTATED_LINE)}\`;\n`,
      },
    );
    mkdirSync(path.join(repo.root, 'node_modules'));
    symlinkSync(fileURLToPath(new URL('../node_modules/e2e', import.meta.url)), path.join(repo.root, 'node_modules', 'e2e'));
    writeFileSync(path.join(repo.root, '.git', 'info', 'exclude'), 'node_modules\n');
    const { model, requests } = scriptedJudge(() => 0.9);
    await list({
      cwd: repo.root,
      changedSince: repo.base,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
      config: {
        targets: [{ engine: web(), app: { url: 'http://127.0.0.1:9' } }],
        secrets: { deployKey: PRIVATE_KEY },
        filters: [decisionFilter({ model })],
      },
    });
    expect(requests).toHaveLength(1);
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toContain('-export const rotated = 1;\n+export const rotated = 2;\n');
    expect(state.diff).toContain(`+${ROTATED_LINE}`);
    for (const line of PRIVATE_KEY.split('\n')) expect(JSON.stringify(requests)).not.toContain(line);
  });
});
