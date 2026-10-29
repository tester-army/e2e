---
"e2e": patch
---

`app.startRecording()` and `app.stopRecording()` record one span of the screen, such as a single transition, on the web and on devices. `stopRecording` returns the videos: a file `path`, or a `url` when a hosted browser or device keeps the recording. A start fails while the test's `video` records, so set `{ video: 'off' }` on the test.

```ts
test('the dialog opens', { video: 'off' }, async ({ app, screen }) => {
  await app.open();
  await app.startRecording({ name: 'dialog' });
  await screen.getByRole('button', 'Open').tap();
  const [video] = await app.stopRecording();
});
```

An engine's `startVideo` and `stopVideo` may now be called more than once per attempt, never overlapping.
