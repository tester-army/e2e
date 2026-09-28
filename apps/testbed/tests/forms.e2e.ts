import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('forms', { tags: ['forms'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/forms');
  });

  test('fills, clears, and submits a profile', async ({ screen }) => {
    await screen.getByLabel('Full name').fill('Ada Lovelace');
    await screen.getByPlaceholder('Tell us about yourself').fill('First programmer.');
    await screen.getByLabel('Team').selectOption('Web');
    await expect(screen.getByLabel('Team')).toHaveValue('web');
    await screen.getByLabel('Team').selectOption({ index: 2 });
    await expect(screen.getByLabel('Team')).toHaveValue('mobile');

    const notifications = screen.getByRole('group', { name: 'Notifications' });
    await expect(notifications.getByRole('checkbox')).toHaveCount(2);
    await screen.getByLabel('Email notifications').check();
    await screen.getByLabel('Weekly digest').uncheck();
    await expect(screen.getByLabel('Email notifications')).toBeChecked();
    await expect(screen.getByLabel('Weekly digest')).not.toBeChecked();

    await screen.getByRole('button', { name: 'Save profile' }).tap();
    await expect(screen.getByRole('status', { name: 'Save result' })).toHaveText(
      'Saved profile for Ada Lovelace',
    );
  });

  test('validates required fields', async ({ screen }) => {
    await screen.getByLabel('Full name').fill('temp');
    await screen.getByLabel('Full name').clear();
    await screen.getByRole('button', { name: 'Save profile' }).tap();
    await expect(screen.getByRole('status', { name: 'Save result' })).toHaveText(
      'Name is required',
    );
  });

  test('reads current values without retrying', async ({ screen }) => {
    const prefilled = screen.getByDisplayValue('prefilled-value');
    await expect(prefilled).toBeVisible();

    await screen.getByLabel('Full name').fill('Grace');
    const value = await screen.getByLabel('Full name').inputValue();
    expect(value).toBe('Grace');
    const placeholder = await screen.getByLabel('Full name').getAttribute('placeholder');
    expect(placeholder).toBe('Ada Lovelace');
  });

  test('types with key events where fill leaves the app cold', async ({ screen }) => {
    const city = screen.getByLabel('City');
    const suggestions = screen.getByRole('list', { name: 'City suggestions' }).getByRole('listitem');

    await city.fill('W');
    await expect(city).toHaveValue('W');
    await expect(suggestions).toHaveCount(0);

    await city.clear();
    await city.pressSequentially('Wa', { delay: 20 });
    await expect(city).toHaveValue('Wa');
    await expect(suggestions).toHaveCount(1);
    await expect(suggestions.first()).toHaveText('Warsaw');
  });

  test('drives the page with raw keyboard input', async ({ screen, web }) => {
    await screen.getByLabel('Full name').focus();
    await web.keyboard.type('Margaret');
    await web.keyboard.press('Backspace');
    await expect(screen.getByLabel('Full name')).toHaveValue('Margare');
  });
});
