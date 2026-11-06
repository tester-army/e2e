/**
 * Selector chains on the BiDi driver: CSS's universal selector stays CSS
 * wherever it stands, and only a `*` before an engine prefix marks a capture.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectElements } from '../../src/driver/frames.ts';
import { openBidiPage, type BidiPage } from '../helpers/bidi-page.ts';

let page: BidiPage;

beforeAll(async () => {
  page = await openBidiPage();
  await page.setContent('<section><div><button>Hi</button></div></section>');
});

afterAll(async () => {
  await page?.close();
});

/** The tag names of the elements `selector` matches on the driver. */
async function names(selector: string): Promise<string[]> {
  return (await selectElements(page.connection, page.context, selector)).map((each) => each.localName);
}

/** The tag names `querySelectorAll` matches for `selector`. */
async function native(selector: string): Promise<string[]> {
  return (await page.evaluate((value: string) => [...document.querySelectorAll(value)].map((element) => element.localName), selector)) as string[];
}

describe('selector chains on the BiDi driver', () => {
  it('reads a universal selector as CSS', async () => {
    for (const selector of ['*', '* > button', 'div > *']) {
      expect(await names(selector), selector).toEqual(await native(selector));
    }
    expect(await names('div > *')).toEqual(['button']);
  });

  it('reads a universal selector inside a chain as CSS', async () => {
    expect(await names('section >> *')).toEqual(['div', 'button']);
    expect(await names('* >> button')).toEqual(['button']);
    expect(await names('css=*')).toEqual(await native('*'));
  });

  it('still rejects a capture before the last part', async () => {
    await expect(names('*css=section >> button')).rejects.toThrow('a selector that captures with * (*css=article >> text=Hello) is not supported: use filter({ has }) instead');
    expect(await names('section >> *css=button')).toEqual(['button']);
  });
});
