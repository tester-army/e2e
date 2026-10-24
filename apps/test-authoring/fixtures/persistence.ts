import type { HardFixture } from '../harder.ts';

const requirement = `# Willow Settings

Willow Settings has one synthetic account, Alex Morgan, with account identifier account-1. There is no account switcher or login. Email updates starts On.

## Overview and settings

The Overview navigation link shows Alex Morgan and the saved Email updates value as On or Off. The Settings navigation link opens a form with a labeled Email updates checkbox and a Save preferences button. The checked state means On. The unchecked state means Off.

Opening Settings loads the saved preference. Changing the checkbox changes the form only. Navigation away discards an unsaved change. Returning to Settings restores the saved value. Saving either boolean value is supported.

## Saving

Save preferences commits the selected boolean for account-1 and shows Preferences saved. The form, Overview, a newly opened Settings screen, and a reload all show that saved value. Saving the same value again has the same result as saving it once. Saving does not create another account or another preference record.

Navigation alone never changes a saved preference. Reload preserves the last saved value. A fresh browser context starts with the initial On value. The app sends no email and makes no remote account change.
`;

export const persistence = {
  id: 'persistence',
  name: 'willow-settings',
  kind: 'safeguard',
  requirement,
  files: {
    'PRODUCT.md': requirement,
    'index.html': `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Willow Settings</title></head>
<body>
<h1>Willow Settings</h1>
<p>Alex Morgan</p><p>Account identifier: account-1</p>
<nav><a href="#overview">Overview</a> <a href="#settings">Settings</a></nav>
<main></main>
<p role="status" aria-label="Save result"></p>
<script type="module" src="/app.js"></script>
</body>
</html>
`,
    'rules.mjs': `export const formatAccountName = name => name.trim().replace(/\\s+/g, ' ');
`,
    'app.js': `const storageKey = 'willow-account-1-email-updates:v1';
let saved = JSON.parse(localStorage.getItem(storageKey) ?? 'true');
let page = 'settings';
const main = document.querySelector('main');
const result = document.querySelector('[aria-label="Save result"]');

const render = () => {
  if (page === 'overview') {
    main.innerHTML = '<h2>Overview</h2><p>Alex Morgan</p>' +
      '<p role="status" aria-label="Email updates">' + (saved ? 'On' : 'Off') + '</p>';
    return;
  }
  main.innerHTML = '<h2>Settings</h2><form><label>Email updates <input type="checkbox"' +
    (saved ? ' checked' : '') + '></label><button type="submit">Save preferences</button></form>';
};

document.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  page = link.getAttribute('href').slice(1);
  result.textContent = '';
  render();
});

document.addEventListener('change', event => {
  if (event.target.matches('input[type=checkbox]')) result.textContent = '';
});

document.addEventListener('submit', event => {
  event.preventDefault();
  saved = main.querySelector('input').checked;
  localStorage.setItem(storageKey, JSON.stringify(saved));
  result.textContent = 'Preferences saved';
});

render();
`,
    'lower/rules.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAccountName } from '../rules.mjs';

test('account name display formatting', () => {
  assert.equal(formatAccountName(' Alex   Morgan '), 'Alex Morgan');
  assert.equal(formatAccountName('Taylor Reed'), 'Taylor Reed');
});
`,
  },
  lowerExit: 0,
  mutationFile: 'app.js',
  mutation: [`  localStorage.setItem(storageKey, JSON.stringify(saved));
`, ``],
  strong: `await expect(screen.getByLabel('Email updates')).toBeChecked();
  await screen.getByRole('link', 'Overview').tap();
  await expect(screen.getByRole('status', 'Email updates')).toHaveText('On');
  await screen.getByRole('link', 'Settings').tap();
  await screen.getByLabel('Email updates').uncheck();
  await screen.getByRole('button', 'Save preferences').tap();
  await expect(screen.getByRole('status', 'Save result')).toHaveText('Preferences saved');
  await screen.getByRole('link', 'Overview').tap();
  await expect(screen.getByRole('status', 'Email updates')).toHaveText('Off');
  await screen.getByRole('link', 'Settings').tap();
  await expect(screen.getByLabel('Email updates')).toBeChecked({ checked: false });
  await app.open('/');
  await expect(screen.getByLabel('Email updates')).toBeChecked({ checked: false });
  await screen.getByRole('link', 'Overview').tap();
  await expect(screen.getByRole('status', 'Email updates')).toHaveText('Off');`,
  weak: `await screen.getByRole('link', 'Settings').tap();
  await screen.getByLabel('Email updates').uncheck();
  await screen.getByRole('button', 'Save preferences').tap();
  await expect(screen.getByRole('status', 'Save result')).toHaveText('Preferences saved');
  await screen.getByRole('link', 'Overview').tap();
  await expect(screen.getByRole('status', 'Email updates')).toHaveText('Off');
  await screen.getByRole('link', 'Settings').tap();
  await expect(screen.getByLabel('Email updates')).toBeChecked({ checked: false });`,
  expected: 'unchecked',
} satisfies HardFixture;
