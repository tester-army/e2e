/**
 * The grammar verbs beyond tap and type against a real model: hover, the tap
 * variants, drag, check, upload, scroll into view, and back, each on the
 * playground control built for its deterministic twin. Every step is pinned
 * by a locator check, so a model that reached the goal another way still
 * passes and one that only claimed to does not.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('hover reveals the card menu and the agent archives the card', async ({ web, agent, screen }) => {
  await web.goto('/board');
  await agent.act('archive the Design review card; the archive action shows when the card actions are hovered');
  await expect(screen.getByLabel('Board state')).toHaveText('Design review is archived');
});

test('a right-click opens the file menu and the agent renames the file', async ({ web, agent, screen }) => {
  await web.goto('/controls');
  await agent.act('open the context menu of report.pdf with a right-click and choose Rename');
  await expect(screen.getByRole('status', { name: 'File state' })).toHaveText('renamed');
});

test('a long press and a double tap are chosen over a plain tap', async ({ web, agent, screen }) => {
  await web.goto('/controls');
  const gesture = screen.getByRole('status', { name: 'Gesture state' });
  await agent.act('long-press the Hold me button until the gesture state reads long-pressed');
  await expect(gesture).toHaveText('long-pressed');
  await agent.act('double-tap the Tap me twice button');
  await expect(gesture).toHaveText('double-tapped');
});

test('a drag moves the card into the done column', async ({ web, agent, screen }) => {
  await web.goto('/board');
  await agent.act('move the Design review card into the Done column');
  await expect(screen.getByLabel('Board state')).toHaveText('Design review is done');
});

test('check sets the checkbox and the radio without flipping them back', async ({ web, agent, screen }) => {
  await web.goto('/controls');
  await agent.act('agree to the terms and pick the Medium size, then confirm both are set');
  await expect(screen.getByLabel('Agree to terms')).toBeChecked();
  await expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();
});

test('upload attaches the named project files', async ({ web, agent, screen }) => {
  await web.goto('/controls');
  await agent.act('attach both files to the Attachments input', {
    params: { files: ['fixtures/attachment.txt', 'fixtures/second.txt'] },
  });
  await expect(screen.getByLabel('Attachments state')).toHaveText('attachment.txt, second.txt');
});

test('scroll_to brings the footnote into view', async ({ web, agent, screen }) => {
  await web.goto('/controls');
  await agent.act('bring the Footnote paragraph at the bottom of the page into view');
  await expect(screen.getByLabel('Footnote state')).toHaveText('in view');
});

test('back returns to the previous page', async ({ web, agent }) => {
  await web.goto('/controls');
  await agent.act('open the Docs link, then go back to the controls page');
  await expect(web).toHaveURL('/controls');
});
