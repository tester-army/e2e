import { describe, expect, it } from 'vitest';
import { SecretLedger } from '../../src/internal/redact.ts';
import { McpOutput } from '../../src/mcp/output.ts';

const TOKEN = 'mcp-output-token-1';

function output(): { out: McpOutput; ledger: SecretLedger; text: () => string } {
  const ledger = new SecretLedger();
  const written: string[] = [];
  const sink = (text: string): boolean => {
    written.push(text);
    return true;
  };
  return { out: new McpOutput(sink, ledger), ledger, text: () => written.join('') };
}

describe('McpOutput', () => {
  it('holds what is printed during a load and releases it redacted with the secrets the load registered', async () => {
    const { out, ledger, text } = output();
    await out.withholdDuring(async () => {
      out.write('stdout', `config: ${TOKEN}\n`);
      expect(text()).toBe('');
      ledger.register('apiToken', TOKEN);
    });
    expect(text()).toBe('config: <secret:apiToken>\n');
  });

  it('withholds everything printed while a load that failed was in flight, other loads included', async () => {
    const { out, ledger, text } = output();
    let finishOther!: () => void;
    const other = out.withholdDuring(() => new Promise<void>((resolve) => (finishOther = resolve)));
    await expect(
      out.withholdDuring(async () => {
        out.write('stderr', `broken: ${TOKEN}\n`);
        throw new Error('config refuses to load');
      }),
    ).rejects.toThrow('config refuses to load');
    ledger.register('other', 'other-secret-value');
    finishOther();
    await other;
    expect(text()).not.toContain(TOKEN);
    expect(text()).toContain('withheld');

    out.write('stdout', 'after the loads\n');
    expect(text()).toContain('after the loads\n');
  });

  it('withholds output held for a load still in flight at shutdown, a report of an uncaught error included', () => {
    const { out, text } = output();
    void out.withholdDuring(() => new Promise<void>(() => undefined));
    out.write('stdout', `mid-load: ${TOKEN}\n`);
    out.report(`e2e mcp: [error] uncaught: Error: ${TOKEN}`);
    expect(text()).toBe('');
    out.end();
    expect(text()).not.toContain(TOKEN);
    expect(text()).toContain('withheld');
  });

  it('releases a held tail redacted once no tool call is in flight', async () => {
    const { out, ledger, text } = output();
    ledger.register('apiToken', TOKEN);
    let finishOther!: () => void;
    const other = out.duringCall(() => new Promise<void>((resolve) => (finishOther = resolve)));
    await out.duringCall(async () => {
      out.write('stdout', `tail: ${TOKEN.slice(0, 6)}`);
    });
    expect(text()).not.toContain(TOKEN.slice(0, 6));
    out.write('stdout', TOKEN.slice(6));
    finishOther();
    await other;
    expect(text()).toBe('tail: <secret:apiToken>');
  });

  it('redacts a value split across stdout and stderr, which land on one stream', () => {
    const { out, ledger, text } = output();
    ledger.register('apiToken', TOKEN);
    out.write('stdout', Buffer.from(TOKEN.slice(0, 6)));
    out.write('stderr', `${TOKEN.slice(6)}\n`);
    out.end();
    expect(text()).toBe('<secret:apiToken>\n');
  });

  it('puts its own lines on a line of their own after an unfinished user line', () => {
    const { out, text } = output();
    out.write('stdout', 'progress');
    out.log('e2e mcp: [info] closing');
    out.end();
    expect(text()).toMatch(/^progress\ne2e mcp: \[info\] closing\n$/);
  });
});
