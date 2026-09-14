import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

/**
 * seleniumbase.io/apps/calculator is a keypad whose buttons are named by their
 * glyphs (`×`, `÷`, `←`) and whose only output is a read-only input. It is the
 * cheapest available check that a long sequence of taps stays ordered and that
 * every tap lands on the button its name says.
 */
test.describe('calculator', { requires: ['web'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/apps/calculator');
  });

  test('evaluates a mixed-precedence expression', async ({ screen, web }) => {
    const output = web.locator('#output');
    await expect(output).toHaveValue('0');

    for (const key of ['7', '×', '6', '+', '1']) {
      await screen.getByRole('button', { name: key }).tap();
    }
    await expect(output).toHaveValue('7×6+1');
    await screen.getByRole('button', { name: '=' }).tap();
    await expect(output).toHaveValue('43');
  });

  test('backspace and clear', async ({ screen, web }) => {
    const output = web.locator('#output');
    for (const key of ['1', '2', '3']) {
      await screen.getByRole('button', { name: key }).tap();
    }
    await screen.getByRole('button', { name: '←' }).tap();
    await expect(output).toHaveValue('12');
    await screen.getByRole('button', { name: 'C' }).tap();
    await expect(output).toHaveValue('0');
  });

  test('division by zero reports an error', async ({ screen, web }) => {
    for (const key of ['5', '÷', '0', '=']) {
      await screen.getByRole('button', { name: key }).tap();
    }
    await expect(web.locator('#output')).toHaveValue('Error');
  });

  test('decimals add up', async ({ screen, web }) => {
    for (const key of ['1', '.', '2', '+', '3', '.', '8']) {
      await screen.getByRole('button', { name: key }).tap();
    }
    await expect(web.locator('#output')).toHaveValue('1.2+3.8');
    await screen.getByRole('button', { name: '=' }).tap();
    await expect(web.locator('#output')).toHaveValue('5');
  });

  test('a hidden toggle is only reachable through its label', async ({ web }) => {
    // `#switch` is the styled-checkbox pattern: the input is visually replaced
    // by `label.toggle`, so it is never actionable itself.
    const toggle = web.locator('#switch');
    await expect(toggle).toBeChecked();
    expect(await toggle.isVisible()).toBe(false);

    await web.locator('label.toggle').tap();
    await expect(toggle).not.toBeChecked();
    const dark = await web.evaluate(() => document.body.classList.contains('dark-mode'));
    expect(dark).toBe(true);
  });

  test('an easter-egg expression navigates away', async ({ screen, web }) => {
    for (const key of ['(', '0', '÷', '0', '÷', '0', '÷', '0', ')']) {
      await screen.getByRole('button', { name: key }).tap();
    }
    await screen.getByRole('button', { name: '=' }).tap();
    await expect(web).toHaveURL(/error_page/);
    await expect(web).toHaveTitle('Error Page');
  });
});
