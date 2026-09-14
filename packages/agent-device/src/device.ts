/**
 * The `device` fixture: deterministic device management this engine
 * contributes. Not an agent tool; a test calls these directly to arrange or
 * assert device state, and the harness records each call as a
 * `device.<method>` step bounded by the action timeout.
 */

import type { EngineFixtureContext, Locator } from 'e2e/engine';
import type { AgentDeviceSurface, InstallAppOptions, InstalledApp } from './surface.ts';

/** Permissions agent-device can grant, deny, or reset on an open app. */
export type DevicePermission =
  | 'camera'
  | 'microphone'
  | 'photos'
  | 'contacts'
  | 'notifications'
  | 'calendar'
  | 'location'
  | 'reminders'
  | 'motion'
  | 'siri'
  | 'media-library';

/** Orientations `setOrientation` accepts. */
export type DeviceOrientation = 'portrait' | 'portrait-upside-down' | 'landscape-left' | 'landscape-right';

export type BiometricSensor = 'faceid' | 'touchid' | 'fingerprint';

export interface ForegroundApp {
  readonly name: string;
  readonly bundleId?: string;
}

/** Deterministic device management exposed to tests as `device`. */
export interface Device {
  /**
   * A locator from an agent-device selector (`'id=SW_VERSION_SPECIFIER'`,
   * `'role=StaticText label="26.2"'`), for nodes the closed `screen` query
   * vocabulary cannot name. Same polling and strictness as any locator.
   */
  locator(selector: string): Locator;
  /** Toggles the device's Wi-Fi. */
  setNetwork(state: 'online' | 'offline'): Promise<void>;
  /** Toggles airplane mode. */
  setAirplaneMode(enabled: boolean): Promise<void>;
  /** Grants, denies, or resets one permission for the open app. */
  setPermission(permission: DevicePermission, state: 'grant' | 'deny' | 'reset'): Promise<void>;
  /** Sets the simulated location. */
  setLocation(coordinates: { latitude: number; longitude: number }): Promise<void>;
  /** Turns simulated location off. */
  clearLocation(): Promise<void>;
  /** Sets the system appearance. */
  setAppearance(mode: 'light' | 'dark'): Promise<void>;
  /** Rotates the device. */
  setOrientation(orientation: DeviceOrientation): Promise<void>;
  /** Simulates one biometric attempt on the open app. */
  setBiometrics(sensor: BiometricSensor, result: 'match' | 'nonmatch'): Promise<void>;
  /** Enrolls or unenrolls the simulator's Face ID or Touch ID. */
  enrollBiometrics(sensor: 'faceid' | 'touchid', enrolled: boolean): Promise<void>;
  /**
   * Installs a build (an iOS `.app` bundle or an Android `.apk`, resolved
   * against the project root) on the device. `reinstall: true` removes
   * the app first so it starts with no data; a plain install replaces the
   * binary and keeps its data. Resolves to the identity to `openApp` it by.
   */
  installApp(appPath: string, options?: InstallAppOptions): Promise<InstalledApp>;
  /** Brings an app to the foreground; `relaunch` restarts it fresh. */
  openApp(app: string, options?: { relaunch?: boolean }): Promise<void>;
  /** Closes the session's current app. */
  closeApp(): Promise<void>;
  /** The app currently in the foreground of the session. */
  foregroundApp(): Promise<ForegroundApp>;
  /** Sends the device to its home screen. */
  home(): Promise<void>;
  /** Navigates back once (in-app back). */
  back(): Promise<void>;
  /** Accepts or dismisses the visible system alert. */
  alert(action: 'accept' | 'dismiss'): Promise<void>;
  /** Dismisses the soft keyboard. */
  dismissKeyboard(): Promise<void>;
  /** Reads the clipboard. */
  clipboard(): Promise<string>;
  /** Writes the clipboard. */
  setClipboard(text: string): Promise<void>;
}

/** Builds the device fixture for one attempt. */
export function createDeviceFixture(surface: AgentDeviceSurface, context: EngineFixtureContext): Device {
  const device: Device = {
    locator: (selector) => context.locator({ kind: 'selector', selector }),
    async setNetwork(state) {
      await surface.command(
        'device.setNetwork',
        (client) => client.settings.update({ setting: 'wifi', state: state === 'offline' ? 'off' : 'on' }),
        context.signal,
      );
    },
    async setAirplaneMode(enabled) {
      await surface.command(
        'device.setAirplaneMode',
        (client) => client.settings.update({ setting: 'airplane', state: enabled ? 'on' : 'off' }),
        context.signal,
      );
    },
    async setPermission(permission, state) {
      await surface.command(
        'device.setPermission',
        (client) => client.settings.update({ setting: 'permission', permission, state }),
        context.signal,
      );
    },
    async setLocation({ latitude, longitude }) {
      await surface.command(
        'device.setLocation',
        (client) => client.settings.update({ setting: 'location', state: 'set', latitude, longitude }),
        context.signal,
      );
    },
    async clearLocation() {
      await surface.command(
        'device.clearLocation',
        (client) => client.settings.update({ setting: 'location', state: 'off' }),
        context.signal,
      );
    },
    async setAppearance(mode) {
      await surface.command(
        'device.setAppearance',
        (client) => client.settings.update({ setting: 'appearance', state: mode }),
        context.signal,
      );
    },
    async setOrientation(orientation) {
      await surface.command('device.setOrientation', (client) => client.command.orientation({ orientation }), context.signal);
    },
    async setBiometrics(sensor, result) {
      await surface.command(
        'device.setBiometrics',
        (client) =>
          sensor === 'fingerprint'
            ? client.settings.update({ setting: 'fingerprint', state: result })
            : client.settings.update({ setting: sensor, state: result }),
        context.signal,
      );
    },
    async enrollBiometrics(sensor, enrolled) {
      await surface.command(
        'device.enrollBiometrics',
        (client) => client.settings.update({ setting: sensor, state: enrolled ? 'enroll' : 'unenroll' }),
        context.signal,
      );
    },
    async installApp(appPath, options) {
      return surface.installApp(appPath, options ?? {}, context.signal);
    },
    async openApp(app, options) {
      await surface.openApp(app, options?.relaunch === true, context.signal);
    },
    async closeApp() {
      await surface.command('device.closeApp', (client) => client.apps.close({}), context.signal);
    },
    async foregroundApp() {
      const state = await surface.command('device.foregroundApp', (client) => client.command.appState({}), context.signal);
      if ('package' in state) return { name: state.package, bundleId: state.package };
      return {
        name: state.appName,
        ...(state.appBundleId === undefined ? {} : { bundleId: state.appBundleId }),
      };
    },
    async home() {
      await surface.command('device.home', (client) => client.command.home({}), context.signal);
    },
    async back() {
      await surface.command('device.back', (client) => client.command.back({ ...surface.settleOptions }), context.signal);
    },
    async alert(action) {
      await surface.command('device.alert', (client) => client.command.alert({ action }), context.signal);
    },
    async dismissKeyboard() {
      await surface.command('device.dismissKeyboard', (client) => client.command.keyboard({ action: 'dismiss' }), context.signal);
    },
    async clipboard() {
      const result = await surface.command(
        'device.clipboard',
        (client) => client.command.clipboard({ action: 'read' }),
        context.signal,
      );
      return result.action === 'read' ? result.text : '';
    },
    async setClipboard(text) {
      await surface.command('device.setClipboard', (client) => client.command.clipboard({ action: 'write', text }), context.signal);
    },
  };
  const action = { kind: 'resource' } as const;
  return context.fixture('device', device, {
    setNetwork: { ...action, label: (state) => state },
    setAirplaneMode: action,
    setPermission: { ...action, label: (permission) => permission },
    setLocation: action,
    clearLocation: action,
    setAppearance: { ...action, label: (mode) => mode },
    setOrientation: { ...action, label: (orientation) => orientation },
    setBiometrics: action,
    enrollBiometrics: action,
    installApp: { ...action, label: (appPath) => appPath },
    openApp: { ...action, label: (app) => app },
    closeApp: action,
    foregroundApp: action,
    home: action,
    back: action,
    alert: { ...action, label: (value) => value },
    dismissKeyboard: action,
    clipboard: action,
    setClipboard: { ...action, label: (text) => `${text.length} chars` },
  });
}
