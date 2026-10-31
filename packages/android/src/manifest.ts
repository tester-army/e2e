/**
 * What the on-device engine server is. The server build writes it into the
 * APK as the manifest the server answers `initialize` with, and the client
 * declares it at config load, so both halves read one definition.
 */

import type { EngineManifest } from 'e2e/engine';

export const MANIFEST = {
  name: 'android',
  version: '0.1.0',
  spiVersion: 1,
  platform: 'android',
  workers: 1,
  methods: [
    'engine/observe',
    'engine/perform',
    'engine/performAt',
    'keyboard/type',
    'keyboard/press',
    'keyboard/dismiss',
    'artifacts/screenshot',
    'session/back',
    'session/restart',
    'session/reset',
    'lifecycle/init',
    'lifecycle/startAttempt',
    'lifecycle/endAttempt',
  ],
  actions: ['tap', 'doubleTap', 'longPress', 'fill', 'clear', 'press', 'check', 'uncheck', 'focus', 'dragTo', 'swipe'],
  pointerActions: ['tap', 'doubleTap', 'longPress', 'dragTo', 'swipe', 'swipeTo'],
} satisfies EngineManifest;
