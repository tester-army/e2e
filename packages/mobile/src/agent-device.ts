/**
 * agent-device for custom tools that extend this engine. A project that
 * imports `agent-device` directly has to install it itself, because pnpm
 * does not resolve a bare import from a transitive dependency, and keep it
 * at the exact version this package pins, because two versions do not
 * share one daemon. Importing from here uses the engine's own copy.
 *
 * This re-exports what a tool commonly needs: the client factory, the error
 * helpers, and the types for snapshots, screenshots, targets, gestures,
 * text entry, alerts, and waits. Daemon lifecycle (`ensureDaemon`,
 * `startAgentDevice`) is left out because the engine owns the daemon.
 *
 * Unstable, like `device.unstable_raw`: this is agent-device's API at the
 * version this package pins, and it can change in any release that bumps
 * agent-device.
 */

export {
  AppError,
  centerOfRect,
  createAgentDeviceClient,
  isAgentDeviceError,
  normalizeAgentDeviceError,
} from 'agent-device';

export type {
  AgentDeviceClient,
  AgentDeviceClientConfig,
  AlertAction,
  AlertCommandOptions,
  AppCloseOptions,
  AppErrorCode,
  AppOpenOptions,
  AppOpenResult,
  BackCommandOptions,
  CaptureScreenshotOptions,
  CaptureScreenshotResult,
  CaptureSnapshotOptions,
  CaptureSnapshotResult,
  DragOptions,
  ElementTarget,
  FillOptions,
  FlingOptions,
  InteractionTarget,
  KeyboardCommandOptions,
  LongPressOptions,
  NormalizedError,
  Point,
  PointTarget,
  PressOptions,
  Rect,
  RefTarget,
  ScrollOptions,
  SelectorTarget,
  SnapshotNode,
  SnapshotState,
  SwipeOptions,
  TypeTextOptions,
  WaitCommandOptions,
  WaitCommandResult,
} from 'agent-device';
