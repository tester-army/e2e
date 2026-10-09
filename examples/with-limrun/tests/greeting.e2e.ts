import { expect } from 'e2e';
import { test } from '@e2e-dev/mobile';

test('opens the greeting form', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByText('Say hello', { exact: true })).toBeVisible();
  await expect(screen.getByTestId('name')).toBeVisible();
  await expect(screen.getByTestId('greet')).toBeVisible();
});

test('corrects an empty submission', async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('greet').click();
  await expect(screen.getByText('Enter a name first.', { exact: true })).toBeVisible();

  await screen.getByTestId('name').fill('Ada');
  await screen.getByTestId('greet').click();
  await expect(screen.getByText('Hello, Ada!', { exact: true })).toBeVisible();
  await expect(screen.getByText('Enter a name first.', { exact: true })).not.toBeVisible();
  await app.screenshot('greeting');
});

test('trims spaces around a name', async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('name').fill(' Ada Lovelace ');
  await screen.getByTestId('greet').click();
  await expect(screen.getByText('Hello, Ada Lovelace!', { exact: true })).toBeVisible();
});

test('updates the greeting after another submission', async ({ app, screen }) => {
  await app.open();
  const name = screen.getByTestId('name');
  const greet = screen.getByTestId('greet');

  await name.fill('Ada');
  await greet.click();
  await expect(screen.getByText('Hello, Ada!', { exact: true })).toBeVisible();

  await name.fill('Grace');
  await greet.click();
  await expect(screen.getByText('Hello, Grace!', { exact: true })).toBeVisible();
  await expect(screen.getByText('Hello, Ada!', { exact: true })).not.toBeVisible();
});

test('starts with a fresh form after restarting', async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('name').fill('Ada');
  await screen.getByTestId('greet').click();
  await expect(screen.getByText('Hello, Ada!', { exact: true })).toBeVisible();

  await app.restart();
  await expect(screen.getByText('Say hello', { exact: true })).toBeVisible();
  await expect(screen.getByText('Hello, Ada!', { exact: true })).not.toBeVisible();
  await screen.getByTestId('greet').click();
  await expect(screen.getByText('Enter a name first.', { exact: true })).toBeVisible();
});
