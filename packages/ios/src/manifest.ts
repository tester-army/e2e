/**
 * What the Swift engine server is. The server answers `initialize` with
 * the same manifest (`Manifest.json` in `server/Server/Device.swift`), and
 * the client refuses a server whose manifest differs.
 */

import type { EngineManifest } from 'e2e/engine';

export const MANIFEST = {
  name: 'ios',
  version: '0.1.0',
  spiVersion: 1,
  platform: 'ios',
  workers: 1,
  methods: [
    'engine/observe',
    'engine/perform',
    'engine/performAt',
    'keyboard/type',
    'keyboard/press',
    'artifacts/screenshot',
    'session/back',
    'lifecycle/init',
    'lifecycle/startAttempt',
    'lifecycle/endAttempt',
  ],
  actions: ['tap', 'doubleTap', 'longPress', 'fill', 'clear', 'press', 'check', 'uncheck', 'focus', 'swipe'],
  pointerActions: ['tap', 'doubleTap', 'longPress', 'dragTo', 'swipe', 'swipeTo'],
} satisfies EngineManifest;
