/**
 * The browser `e2e login` opens, as the command it runs. The URL it opens
 * comes from the vendor's own response in the device flow, so the opener
 * must not hand it to a command interpreter: on Windows a shell reads `|`,
 * `&`, and `^` in the URL as command syntax, and a URL that carries one runs
 * a command of its own. The opener hands over the URL the parser read, so the
 * value it checked is the value it opens.
 */

import { describe, expect, it } from 'vitest';
import { browserCommand } from '../../../src/oauth/browser.ts';

/** The characters a command interpreter reads as syntax rather than as text. */
const SHELL_SYNTAX = ['|', '&', '^', '<', '>', '%', '"', ' ', "'"];

describe('browserCommand', () => {
  it('opens an http URL on Windows without a command interpreter', () => {
    const url = 'https://github.com/login/device';
    expect(browserCommand('win32', url)).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
  });

  it('never runs the Windows URL through a shell', () => {
    for (const character of SHELL_SYNTAX) {
      const url = `https://example.com/login/device?code=1${character}calc.exe`;
      const command = browserCommand('win32', url);
      expect(command?.command).toBe('rundll32');
      expect(command?.args).toEqual(['url.dll,FileProtocolHandler', new URL(url).href]);
    }
  });

  it('hands the Windows URL over as one argument', () => {
    const url = 'https://example.com/login/device?code=a&b=^&c|calc.exe%PATH%';
    const command = browserCommand('win32', url);
    expect(command?.args).toHaveLength(2);
    expect(command?.args.at(-1)).toBe(new URL(url).href);
  });

  it('opens the URL the parser read, not the raw string', () => {
    const raw = '  https://EXAMPLE.com/lo\ngin  ';
    expect(browserCommand('win32', raw)?.args.at(-1)).toBe('https://example.com/login');
    expect(browserCommand('darwin', raw)?.args[0]).toBe('https://example.com/login');
    expect(browserCommand('linux', raw)?.args[0]).toBe('https://example.com/login');
  });

  it('opens an http URL on macOS and Linux with the platform opener', () => {
    const url = 'https://example.com/login/device';
    expect(browserCommand('darwin', url)).toEqual({ command: 'open', args: [url] });
    expect(browserCommand('linux', url)).toEqual({ command: 'xdg-open', args: [url] });
  });

  it('refuses every scheme but http and https', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'view-source:https://example.com',
      'blob:https://example.com/1234',
      'about:blank',
      'ms-msdt:/id',
      'not a url at all',
    ]) {
      expect(browserCommand('win32', url)).toBeUndefined();
      expect(browserCommand('darwin', url)).toBeUndefined();
      expect(browserCommand('linux', url)).toBeUndefined();
    }
  });

  it('accepts http and https on every platform', () => {
    for (const url of ['http://localhost:3000/login', 'https://example.com/login/device']) {
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        expect(browserCommand(platform, url)).toBeDefined();
      }
    }
  });
});
