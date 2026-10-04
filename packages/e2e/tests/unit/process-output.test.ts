import { describe, expect, it } from 'vitest';
import { SecretLedger } from '../../src/internal/redact.ts';
import { RunnerOutput, type OutputStream } from '../../src/run/process-output.ts';

const TOKEN = 'runner-output-token-1';

function output() {
  const ledger = new SecretLedger();
  const terminal: Record<OutputStream, string[]> = { stdout: [], stderr: [] };
  const write = (stream: OutputStream) => (text: string, callback?: () => void): boolean => {
    terminal[stream].push(text);
    callback?.();
    return true;
  };
  const out = new RunnerOutput({ stdout: write('stdout'), stderr: write('stderr') }, ledger);
  return { out, ledger, stdout: () => terminal.stdout.join(''), stderr: () => terminal.stderr.join('') };
}

describe('RunnerOutput', () => {
  it('holds what is printed during the config load and releases it redacted with the secrets the load registered', async () => {
    const { out, ledger, stdout, stderr } = output();
    await out.withholdDuring(async () => {
      out.write('stdout', `config: ${TOKEN}\n`);
      out.write('stderr', Buffer.from(`config error: ${TOKEN}\n`));
      expect(stdout() + stderr()).toBe('');
      ledger.register('apiToken', TOKEN);
    });
    expect(stdout()).toBe('config: <secret:apiToken>\n');
    expect(stderr()).toBe('config error: <secret:apiToken>\n');
  });

  it('withholds what was printed while a config failed to load, and passes what follows', async () => {
    const { out, stdout, stderr } = output();
    await expect(
      out.withholdDuring(async () => {
        out.write('stdout', `broken: ${TOKEN}\n`);
        throw new Error('config refuses to load');
      }),
    ).rejects.toThrow('config refuses to load');
    expect(stdout()).toBe('');
    expect(stderr()).toMatch(/^e2e: \[warning\] withheld \d+ bytes of output printed while the config failed to load/);
    out.write('stdout', 'after the load\n');
    expect(stdout()).toBe('after the load\n');
  });

  it('redacts a value split across writes, and releases an unfinished line at the end', () => {
    const { out, ledger, stdout } = output();
    ledger.register('apiToken', TOKEN);
    out.write('stdout', `split: ${TOKEN.slice(0, 8)}`);
    out.write('stdout', `${TOKEN.slice(8)}\nno newline: ${TOKEN}`);
    expect(stdout()).toBe('split: <secret:apiToken>\n');
    out.end();
    expect(stdout()).toBe('split: <secret:apiToken>\nno newline: <secret:apiToken>');
  });

  it('shows output through the list reporter while it is attached, and fires every callback', async () => {
    const { out, ledger, stdout } = output();
    ledger.register('apiToken', TOKEN);
    const shown: string[] = [];
    out.showThrough((stream, text) => shown.push(`${stream}:${text}`));
    let called = 0;
    out.write('stderr', `reporter: ${TOKEN}\n`, () => (called += 1));
    out.write('stdout', 'held tail', () => (called += 1));
    out.showThrough(undefined);
    out.write('stdout', '\n', () => (called += 1));
    await new Promise((resolve) => process.nextTick(resolve));
    expect(shown).toEqual(['stderr:reporter: <secret:apiToken>\n']);
    expect(stdout()).toBe('held tail\n');
    expect(called).toBe(3);
  });
});
