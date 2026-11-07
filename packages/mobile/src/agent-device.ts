/**
 * The engine's own agent-device, for custom tools, so a project never
 * installs a second copy that has to match this package's pin. Daemon
 * lifecycle (`ensureDaemon`, `startAgentDevice`) is left out because the
 * engine owns the daemon. Unstable, like `device.unstable_raw`: it can
 * change in any release that bumps agent-device.
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
