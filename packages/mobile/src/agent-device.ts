/**
 * The engine's own agent-device types and error helpers, for custom tools,
 * so a project never installs a second copy that has to match this
 * package's pin. There is no client factory: a client built outside the
 * engine misses its daemon, lease, and session. A test uses
 * `device.unstable_raw.client` and a tool uses `deviceSession()` from
 * `./tools`. Unstable, like `device.unstable_raw`: it can change in any
 * release that bumps agent-device.
 */

export {
  AppError,
  centerOfRect,
  isAgentDeviceError,
  normalizeAgentDeviceError,
} from 'agent-device';

export type {
  AgentDeviceClient,
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
