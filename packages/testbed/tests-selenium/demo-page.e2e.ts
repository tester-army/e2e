import { test, expect } from 'e2e';

/**
 * seleniumbase.io/demo_page is one wide table holding most of the HTML control
 * surface: text inputs, a read-only field, a range slider, a select, radios,
 * checkboxes, four iframes, a hover-only dropdown, and a row that only exists
 * after a checkbox is ticked.
 *
 * Several controls here carry no accessible name at all — the labels are plain
 * table cells, not `<label for>` — so this file is also where `web.locator`
 * earns its place: a practice page is exactly where a real app's missing
 * semantics show up.
 */
test.describe('demo page', { requires: ['web'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/demo_page');
  });

  test('serves the reference page', async ({ screen, web }) => {
    await expect(web).toHaveTitle('Web Testing Page');
    await expect(screen.getByRole('heading', { name: 'Demo Page' })).toBeVisible();
    await expect(screen.getByRole('heading', { name: 'SeleniumBase' })).toBeVisible();
  });

  test('fills text inputs addressed by id, placeholder, and value', async ({ screen, web }) => {
    await web.locator('#myTextInput').fill('typed by e2e');
    await expect(web.locator('#myTextInput')).toHaveValue('typed by e2e');

    await screen.getByPlaceholder('Placeholder Text Field').fill('placeholder addressed');
    await expect(screen.getByPlaceholder('Placeholder Text Field')).toHaveValue(
      'placeholder addressed',
    );

    // The second text field ships pre-filled, which is the one thing
    // getByDisplayValue is for.
    await expect(screen.getByDisplayValue('Text...')).toBeVisible();
    await web.locator('#myTextarea').fill('multi\nline');
    await expect(web.locator('#myTextarea')).toHaveValue('multi\nline');
  });

  test('a read-only field is visible but not editable', async ({ web }) => {
    const readOnly = web.locator('#readOnlyText');
    await expect(readOnly).toHaveValue('The Color is Green');
    // A read-only input is not disabled, so no state distinguishes it.
    expect(await readOnly.isEnabled()).toBe(true);

    // `getAttribute` reads an *exposed* attribute only: the driver projects a
    // whitelist (`type`, `id`, `name`, `placeholder`, `title`, `alt`, `value`,
    // `href`, `role`, `autocomplete`, `aria-*`). `readonly` is not on it, so
    // this returns `null` for an attribute that is present — indistinguishable
    // from absent.
    expect(await readOnly.getAttribute('readonly')).toBeNull();
    const trulyReadOnly = await web.evaluate(() => {
      const field = document.querySelector('#readOnlyText');
      return field instanceof HTMLInputElement && field.readOnly;
    });
    expect(trulyReadOnly).toBe(true);
  });

  test('a button rewrites the text and the read-only field it owns', async ({ screen, web }) => {
    await screen.getByRole('button', { name: 'Click Me (Green)' }).tap();
    await expect(web.locator('#pText')).toHaveText('This Text is Purple');
    await expect(web.locator('#readOnlyText')).toHaveValue('The Color is Purple');

    await screen.getByRole('button', { name: 'Click Me (Purple)' }).tap();
    await expect(web.locator('#pText')).toHaveText('This Text is Green');
  });

  test('a select drives the meter beside it', async ({ web }) => {
    // No accessible name: the "Select Dropdown:" label is a sibling table cell.
    const select = web.locator('#mySelect');
    await select.selectOption('Set to 75%');
    await expect(web.locator('#meterLabel')).toHaveText('HTML Meter: (75%)');
    await select.selectOption({ index: 3 });
    await expect(web.locator('#meterLabel')).toHaveText('HTML Meter: (100%)');
    await expect(select).toHaveValue('100%');
  });

  test('a range slider responds to keyboard steps', async ({ screen, web }) => {
    const slider = screen.getByRole('slider');
    await expect(web.locator('#progressLabel')).toHaveText('Progress Bar: (50%)');
    await slider.press('ArrowRight');
    await expect(web.locator('#progressLabel')).toHaveText('Progress Bar: (60%)');
    await slider.press('ArrowLeft');
    await slider.press('ArrowLeft');
    await expect(web.locator('#progressLabel')).toHaveText('Progress Bar: (40%)');
  });

  test('checkboxes check, uncheck, and report state', async ({ web }) => {
    await web.locator('#checkBox2').check();
    await web.locator('#checkBox3').check();
    await expect(web.locator('#checkBox2')).toBeChecked();
    await expect(web.locator('#checkBox4')).not.toBeChecked();

    // The fifth box ships checked, so unchecking it is the interesting half.
    await expect(web.locator('#checkBox5')).toBeChecked();
    await web.locator('#checkBox5').uncheck();
    await expect(web.locator('#checkBox5')).not.toBeChecked();
  });

  test('radio buttons are mutually exclusive', async ({ web }) => {
    // `radio` is not in the spec's Role union, so a radio group is only
    // addressable through a web selector today.
    await expect(web.locator('#radioButton1')).toBeChecked();
    await web.locator('#radioButton2').check();
    await expect(web.locator('#radioButton2')).toBeChecked();
    await expect(web.locator('#radioButton1')).not.toBeChecked();
  });

  test('ticking a checkbox reveals a hidden row', async ({ web }) => {
    const hiddenRow = web.locator('#drop1');
    await expect(hiddenRow).toBeHidden();
    await web.locator('#checkBox1').check();
    await expect(hiddenRow).toBeVisible();
    await web.locator('#checkBox1').uncheck();
    await expect(hiddenRow).toBeHidden();
  });

  test('a hover-only dropdown reveals its links', async ({ screen, web }) => {
    const option = web.locator('#dropOption2');
    await expect(option).toBeHidden();
    await screen.getByText('Hover Dropdown').hover();
    await expect(option).toBeVisible();
    await option.tap();
    await expect(screen.getByRole('heading', { name: 'Link Two Selected' })).toBeVisible();
  });

  test('links expose their targets without following them', async ({ screen }) => {
    const github = screen.getByRole('link', { name: 'SeleniumBase on GitHub' });
    expect(await github.getAttribute('href')).toBe('https://github.com/seleniumbase/SeleniumBase');
    await expect(screen.getByRole('link', { name: 'seleniumbase.io' })).toBeVisible();
  });

  test('an iframe checkbox is reachable through its frame', async ({ web }) => {
    // The frame is a `data:text/html` document, so this also covers a frame
    // with no origin of its own.
    const box = web.frameLocator('#myFrame3').getByRole('checkbox');
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
  });

  test('a frame text query does not leak into the host page', async ({ screen, web }) => {
    await expect(screen.getByText('iFrame Text')).toBeHidden();
    await expect(web.frameLocator('#myFrame2').getByText('iFrame Text')).toBeVisible();
  });
});
