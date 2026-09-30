/**
 * An email's text: the HTML part's visible text with each link's URL after
 * its label, else the plain part. Hidden elements,
 * Outlook conditionals, comments, styles, and scripts are left out, cells do
 * not run together, and rendering stays linear on hostile markup.
 */

import { describe, expect, it } from 'vitest';
import { renderHtml, toEmailMessage } from '../../src/email/message.ts';

function received(parts: { text?: string; html?: string }) {
  return toEmailMessage({ id: 'm1', from: 'Acme <noreply@acme.test>', to: ['qa@inbox.test'], subject: 'Verify', text: parts.text, html: parts.html, receivedAt: new Date(0) });
}

describe('text', () => {
  it('is the HTML part rendered when there is one, the plain part otherwise', () => {
    expect(received({ text: 'Confirm: https://app.test/c?t=1', html: '<a href="https://app.test/c?t=1">Confirm</a>' }).text).toBe('Confirm <https://app.test/c?t=1>');
    expect(received({ text: 'plain body', html: ' ' }).text).toBe('plain body');
    expect(received({ text: 'plain body' }).text).toBe('plain body');
    expect(received({}).text).toBe('');
  });
});

describe('renderHtml', () => {
  it('renders visible text, one block per line, entities decoded and invisible padding dropped', () => {
    expect(
      renderHtml(
        '<!doctype html><html><head><title>t</title><style>p{color:red}</style></head><body><p>Hello&nbsp;<b>Ada</b>,</p><p>Here&rsquo;s your code:&zwnj;&#8203; <strong>482913</strong>.</p><br/>&copy; Acme &mdash; &#x41; &bogus;</body></html>',
      ),
    ).toBe('Hello Ada,\nHere’s your code: 482913.\n© Acme — A &bogus;');
  });

  it('decodes Latin-1 names by case, and the five a browser reads without a semicolon', () => {
    expect(renderHtml('<p>Caf&eacute; &Eacute;cole &szlig; &frac12; &AMP; &euml &lt 3</p><a href="https://acme.test/v?a=1&amp=2&b=3&lt=4">Go</a>')).toBe(
      'Café École ß ½ & &euml < 3\nGo <https://acme.test/v?a=1&amp=2&b=3&lt=4>',
    );
  });

  it('keeps table cells apart and runs inline elements together, as a browser draws them', () => {
    expect(renderHtml('<table><tr><td>Code:</td><td>482913</td></tr></table><p><span>48</span><span>29</span><b>13</b></p>')).toBe('Code: 482913\n482913');
  });

  it('puts each link\'s URL after its label, once when the label is the URL, with an image\'s alt for a label', () => {
    expect(
      renderHtml(
        '<a href="https://u1.ct.sendgrid.net/ls/click?upn=a&amp;b=1" class="btn"><span>Confirm</span> email</a> <a href="https://acme.test/x">https://acme.test/x</a> <a href=\'mailto:help@acme.test\'>Help</a> <a href="https://acme.test/logo"><img alt="Acme"></a> <a data-href="https://tracker.test" href="https://acme.test/real">Real</a> <a href="https://acme.test/\n  split">Split</a>',
      ),
    ).toBe('Confirm email <https://u1.ct.sendgrid.net/ls/click?upn=a&b=1> https://acme.test/x Help Acme <https://acme.test/logo> Real <https://acme.test/real> Split <https://acme.test/split>');
  });

  it('leaves out hidden elements, comments, and Outlook-only blocks, keeping what they wrap for other clients', () => {
    expect(
      renderHtml(
        '<div style="display:none;max-height:0">Preheader 999999</div><div hidden>also hidden</div><span style="mso-hide:all">outlook</span><!--[if mso]><table><tr><td>MSO button</td></tr></table><![endif]--><!--[if !mso]><!--><p>Everyone else</p><!--<![endif]--><div style="display:none"><div>nested</div> still hidden</div><p>Shown</p>',
      ),
    ).toBe('Everyone else\nShown');
  });

  it('reads attributes whose values hold ">" and keeps a bare "<" as text', () => {
    expect(renderHtml('<a title="a > b" href="https://acme.test/ok">OK</a> 1 < 2 and <b>bold</b>')).toBe('OK <https://acme.test/ok> 1 < 2 and bold');
  });

  it('keeps what follows a hidden element whose end tag is left out, and what a hidden element\'s comment spells', () => {
    expect(renderHtml('<p style="display:none">Preheader<p>Your code is 123456<p>Thanks')).toBe('Your code is 123456\nThanks');
    expect(renderHtml('<table><tr><td style="display:none">x<td>Code 123456</table>')).toBe('Code 123456');
    expect(renderHtml('<ul><li hidden>a<li>Code 123456</ul>')).toBe('Code 123456');
    expect(renderHtml('<table><tr><td hidden><table><tr><td>inner</td></tr></table></td><td>Code 123456</td></tr></table>')).toBe('Code 123456');
    expect(renderHtml('<div style="display:none"><!--[if mso]><div>x<![endif]-->preheader</div><p>Your code is 123456</p>')).toBe('Your code is 123456');
    expect(renderHtml('<div hidden><!-- a > b </div> --></div><p>Shown</p>')).toBe('Shown');
  });

  it('reads an unquoted href whole, and text whose lowercase form is longer', () => {
    expect(renderHtml('<a href=https://x.test/v?t=1&amp;u=2>Verify</a>')).toBe('Verify <https://x.test/v?t=1&u=2>');
    expect(renderHtml('<p>\u0130\u0130\u0130<style>x</style>Code 123</p><p>Next</p>')).toBe('\u0130\u0130\u0130Code 123\nNext');
  });

  it('closes an anchor a new one opens, as anchors do not nest', () => {
    expect(renderHtml('<a href="https://a.test">A<a href="https://b.test">B</a></a>')).toBe('A <https://a.test>B <https://b.test>');
  });

  it('stays linear on markup that would make a backtracking pattern hang', () => {
    // The fastest of a few runs, so a GC pause or a busy runner does not read as a slow scan.
    const time = (html: string): number =>
      Math.min(
        ...Array.from({ length: 3 }, () => {
          const started = performance.now();
          renderHtml(html);
          return performance.now() - started;
        }),
      );
    // Doubling the input at most roughly doubles the time; a quadratic scan quadruples it.
    const scales = (unit: string, count: number): void => {
      time(unit.repeat(count));
      const once = time(unit.repeat(count));
      const twice = time(unit.repeat(count * 2));
      expect(twice, unit).toBeLessThan(once * 3 + 50);
    };
    scales('<a href=https://x.test/a ', 20_000);
    scales('<a href="https://x.test/a">click ', 20_000);
    scales('<a href="https://x.test/a">x', 20_000);
    scales('a < b ', 50_000);
    scales('<a class="x ', 20_000);
    scales('<div style="display:none"><p>', 20_000);
    scales('<table><tr><td style="padding:0"><!--[if mso]><v:roundrect href="https://x"><![endif]--><a href="https://u1.ct.sendgrid.net/ls/click?upn=abcdef" style="color:#fff">Verify</a> &zwnj;&nbsp; 2026</td></tr></table>', 5_000);
  });
});
