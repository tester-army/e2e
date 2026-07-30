import { expect, test } from 'e2e';

/** Android smoke coverage: the same driver against a different platform. */
test('opens Settings and reads a row', async ({ app, screen, platform }) => {
  expect(platform).toBe('android');
  await app.open();
  await expect(screen.getByText('Network & internet')).toBeVisible();
});

test('navigates into a section and back', async ({ app, screen }) => {
  await app.open();
  await screen.getByText('Network & internet').tap();
  await expect(screen.getByText('Internet')).toBeVisible();
  await app.back();
  await expect(screen.getByText('Connected devices')).toBeVisible();
});

test('projects the Android list and its rows', async ({ app, screen }) => {
  await app.open();
  // androidx RecyclerView projects to the list role.
  await expect(screen.getByRole('list')).toBeVisible();
  expect(await screen.getByRole('listitem').count()).toBeGreaterThan(0);
});

test('captures a screenshot artifact', async ({ app }) => {
  await app.open();
  expect(await app.screenshot('android-root')).toMatch(/\.png$/);
});

test('finds a switch whose state Android does not expose', async ({ app, screen }) => {
  await app.open();
  await screen.getByText('Network & internet').tap();

  // A real limitation, pinned so a fix upstream is noticed: the Android
  // snapshot helper reports a Switch with no value, selected state, or label,
  // so `checked` cannot be derived. The driver leaves the state unavailable
  // rather than reporting false, which is why this asserts the role only.
  const toggle = screen.getByRole('switch').first();
  await expect(toggle).toBeVisible();
  expect(await toggle.isChecked()).toBe(false);
});
