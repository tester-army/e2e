/**
 * What an agent-device install answers, read the same way by the warm-up in
 * `prepare` and by a worker's own `init` or `device.installApp`.
 */

/** The install fields this engine reads off agent-device's response. */
export interface RawInstallResult {
  readonly app: string;
  readonly appId?: string;
  readonly bundleId?: string;
  readonly package?: string;
}

/** The app an install put on the device, as `openApp` names it. */
export interface InstalledApp {
  /** The bundle id or package to open the app by. */
  readonly app: string;
  readonly bundleId?: string;
}

/** The identity to open an installed app by: its bundle id or package when agent-device named one, else the app as given. */
export function installedApp(result: RawInstallResult): InstalledApp {
  const identity = result.bundleId ?? result.package ?? result.appId;
  return { app: identity ?? result.app, ...(identity === undefined ? {} : { bundleId: identity }) };
}
