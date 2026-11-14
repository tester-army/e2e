/**
 * `e2e-core`: drive a browser or a device from plain code, the way
 * `playwright-core` drives a browser. No test runner, config file, report,
 * or `expect`. The agent is `e2e-core/agent`, so this entry never loads the
 * AI SDK. The test runner, `e2e`, is built on it.
 */

export { launch, type CoreFixtures, type Host, type LaunchApp, type LaunchOptions, type NewSessionOptions, type Session, type SessionControls } from './launch.ts';
export { SessionState, type SessionStateKeyOptions } from './state.ts';
export { ConfigurationError, isE2EError } from '../internal/errors.ts';
export type { EngineHandle } from '../engine/index.ts';
export type {
  ActionOptions,
  App,
  ClickOptions,
  Expectable,
  JsonPrimitive,
  JsonValue,
  Locator,
  Point,
  RecordedVideo,
  RecordingOptions,
  Role,
  RoleOptions,
  Screen,
  Secret,
  SelectOption,
  SwipeOptions,
  TapOptions,
  TargetApp,
  TextMatch,
  TextMatchOptions,
} from '../types.ts';
