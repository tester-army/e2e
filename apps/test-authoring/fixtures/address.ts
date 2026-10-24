import type { HardFixture } from '../harder.ts';

const requirement = `# Maple Delivery

Maple Delivery saves a delivery region for one synthetic account. The saved region starts as United States with postal code 02139. The Overview navigation link shows the saved country and postal code. Delivery details opens the editable form.

## Country and postal code

Country is a labeled select with United States and Canada. Postal code is a labeled text input. It accepts at most 16 UTF-16 code units. A postal code is text, so leading zeroes are preserved. The form loads the saved values when it opens.

United States requires exactly five ASCII digits, 0 through 9. Spaces and every other character are invalid. Canada ignores every ASCII space character U+0020 anywhere in the value, converts ASCII lowercase letters to uppercase, and requires exactly six resulting ASCII characters in the pattern letter, digit, letter, digit, letter, digit. Other whitespace, punctuation, accented letters, and non-ASCII digits are invalid. No postal validity claim extends beyond these two formats.

An empty value, including a Canadian value containing only ASCII spaces, shows Enter a postal code. A nonempty invalid United States value shows Use five ASCII digits for United States. A nonempty invalid Canadian value shows Use the Canadian letter-digit format. The input retains the entered text while invalid.

Validation runs when the postal value changes, when Country changes, and when Save address is submitted. Changing Country preserves the postal text and immediately evaluates that text under the newly selected country. Invalid pairs disable Save address. The current error is visible next to Postal code.

## Saving and navigation

Save address commits a valid country and postal code and shows Address saved. The saved Canadian postal code uses uppercase letters with no spaces. The form displays that canonical saved value after success. A saved United States code retains its five digits exactly.

An invalid submission preserves the previous saved region and shows the applicable error. Saving the same valid pair twice has the same result as saving it once. The Overview summary uses the saved pair. Navigation away discards unsaved form changes. Returning to Delivery details or reloading loads the saved pair. The form never contacts an address lookup service.
`;

export const address = {
  id: 'address',
  name: 'maple-delivery',
  kind: 'informative',
  requirement,
  files: {
    'PRODUCT.md': requirement,
    'index.html': `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Maple Delivery</title></head>
<body>
<h1>Maple Delivery</h1>
<nav aria-label="Main"><a href="#overview" data-page="overview">Overview</a> <a href="#delivery-details" data-page="details">Delivery details</a></nav>
<main></main>
<script type="module" src="/app.js"></script>
</body>
</html>
`,
    'rules.mjs': `export function canonicalPostal(country, postal) {
  return country === 'CA' ? postal.replace(/ /g, '').replace(/[a-z]/g, letter => letter.toUpperCase()) : postal;
}

export function validatePostal(country, postal) {
  const canonical = canonicalPostal(country, postal);
  const valid = country === 'US' ? /^[0-9]{5}$/.test(canonical) : /^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$/.test(canonical);
  const error = canonical.length === 0 ? 'Enter a postal code' : country === 'US' ? 'Use five ASCII digits for United States' : 'Use the Canadian letter-digit format';
  return { valid, error: valid ? '' : error, postal: canonical };
}

export const countryName = country => country === 'US' ? 'United States' : 'Canada';
`,
    'view.mjs': `import { validatePostal } from './rules.mjs';

export function validationForForm(form) {
  const validation = validatePostal(form.country, form.postal);
  return { valid: validation.valid, error: validation.error, postal: validation.postal };
}
`,
    'app.js': `import { validatePostal, countryName } from './rules.mjs';
import { validationForForm } from './view.mjs';

const storageKey = 'maple-delivery:v1';
if (localStorage.getItem(storageKey) === null) localStorage.setItem(storageKey, JSON.stringify({ country: 'US', postal: '02139' }));
let saved = JSON.parse(localStorage.getItem(storageKey));
const main = document.querySelector('main');
let page = 'overview';
let form;

function updateValidation() {
  const input = main.querySelector('[name=postal]');
  const error = main.querySelector('#postal-error');
  error.textContent = form.validation.valid ? '' : form.validation.error;
  input.setAttribute('aria-invalid', String(!form.validation.valid));
  main.querySelector('button').disabled = !form.validation.valid;
}

function render() {
  if (page === 'overview') {
    main.innerHTML = '<h2>Overview</h2><p>Saved country <output aria-label="Saved country">' + countryName(saved.country) + '</output></p><p>Saved postal code <output aria-label="Saved postal code">' + saved.postal + '</output></p>';
    return;
  }
  main.innerHTML = '<h2>Delivery details</h2><form novalidate><label>Country <select name="country"><option value="US">United States</option><option value="CA">Canada</option></select></label><label>Postal code <input name="postal" maxlength="16" aria-describedby="postal-error"></label><p id="postal-error" role="alert" aria-label="Postal code error"></p><button type="submit">Save address</button><p role="status" aria-label="Address status"></p></form>';
  const country = main.querySelector('[name=country]');
  const postal = main.querySelector('[name=postal]');
  const status = main.querySelector('[aria-label="Address status"]');
  country.value = form.country;
  postal.value = form.postal;
  updateValidation();
  country.addEventListener('change', () => {
    form.country = country.value;
    form.validation = validationForForm(form);
    status.textContent = '';
    updateValidation();
  });
  postal.addEventListener('input', () => {
    form.postal = postal.value.slice(0, 16);
    postal.value = form.postal;
    form.validation = validatePostal(form.country, form.postal);
    status.textContent = '';
    updateValidation();
  });
  main.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    form.validation = validationForForm(form);
    updateValidation();
    if (!form.validation.valid) {
      status.textContent = '';
      return;
    }
    saved = { country: form.country, postal: form.validation.postal };
    localStorage.setItem(storageKey, JSON.stringify(saved));
    form.postal = saved.postal;
    postal.value = saved.postal;
    status.textContent = 'Address saved';
  });
}

for (const link of document.querySelectorAll('nav a')) link.addEventListener('click', event => {
  event.preventDefault();
  page = link.dataset.page;
  if (page === 'details') form = { ...saved, validation: validatePostal(saved.country, saved.postal) };
  render();
});
render();
`,
    'lower/rules.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPostal, validatePostal } from '../rules.mjs';

test('country postal formats', () => {
  assert.equal(canonicalPostal('US', '02139'), '02139');
  assert.equal(canonicalPostal('CA', ' k1a 0b1 '), 'K1A0B1');
  assert.deepEqual(validatePostal('US', '02139'), { valid: true, error: '', postal: '02139' });
  assert.deepEqual(validatePostal('CA', 'k1a 0b1'), { valid: true, error: '', postal: 'K1A0B1' });
  assert.equal(validatePostal('CA', 'K 1 A 0 B 1').valid, true);
  assert.equal(validatePostal('US', '').error, 'Enter a postal code');
  assert.equal(validatePostal('CA', '   ').error, 'Enter a postal code');
  assert.equal(validatePostal('US', '0213').error, 'Use five ASCII digits for United States');
  assert.equal(validatePostal('CA', '02139').error, 'Use the Canadian letter-digit format');
  for (const postal of [' 02139', '02139 ', '０２１３９', '٠٢١٣٩', '02139\\n', '02139\\t']) assert.equal(validatePostal('US', postal).valid, false);
  for (const postal of ['K1A-0B1', 'K1A\\t0B1', 'K1A0B1\\n', 'K1A\\u00a00B1', 'É1A0B1', 'K１A0B1']) assert.equal(validatePostal('CA', postal).valid, false);
});
`,
  },
  lowerExit: 0,
  mutationFile: 'view.mjs',
  mutation: [`valid: validation.valid`, `valid: form.validation.valid`],
  strong: `await screen.getByRole('link', 'Delivery details').tap();
  await expect(screen.getByLabel('Postal code')).toHaveValue('02139');
  await screen.getByLabel('Country').selectOption({ value: 'CA' });
  await expect(screen.getByRole('alert', 'Postal code error')).toHaveText('Use the Canadian letter-digit format');
  await expect(screen.getByRole('button', 'Save address')).toBeDisabled();
  await screen.getByLabel('Postal code').fill('K1A 0B1');
  await screen.getByRole('button', 'Save address').tap();
  await expect(screen.getByRole('status', 'Address status')).toHaveText('Address saved');
  await expect(screen.getByLabel('Country')).toHaveValue('CA');
  await expect(screen.getByLabel('Postal code')).toHaveValue('K1A0B1');
  await screen.getByRole('link', 'Overview').tap();
  await expect(screen.getByRole('status', 'Saved country')).toHaveText('Canada');
  await expect(screen.getByRole('status', 'Saved postal code')).toHaveText('K1A0B1');`,
  weak: `await screen.getByRole('link', 'Delivery details').tap();
  await screen.getByLabel('Postal code').fill('');
  await expect(screen.getByRole('alert', 'Postal code error')).toHaveText('Enter a postal code');
  await screen.getByLabel('Country').selectOption({ value: 'CA' });
  await screen.getByLabel('Postal code').fill('k1a 0b1');
  await screen.getByRole('button', 'Save address').tap();
  await expect(screen.getByRole('status', 'Address status')).toHaveText('Address saved');
  await screen.getByRole('link', 'Overview').tap();
  await expect(screen.getByRole('status', 'Saved country')).toHaveText('Canada');
  await expect(screen.getByRole('status', 'Saved postal code')).toHaveText('K1A0B1');`,
  expected: 'Use the Canadian letter-digit format',
} satisfies HardFixture;
