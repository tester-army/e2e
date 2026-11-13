/** A project the server serves: its config, loaded fresh on every use. */

import path from 'node:path';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { type ResolvedConfig } from 'e2e-core/lib/config/resolve';
import { resolveConfig } from '../config/resolve-run.ts';
import { ConfigurationError } from 'e2e-core/lib/internal/errors';
import type { TargetApp } from 'e2e-core/lib/types';
import { loadEngine, type EngineLookup, type FactoryRef } from './default-engine.ts';

export interface ProjectOptions {
  readonly cwd: string;
  /** An explicit config file, relative to `cwd`; otherwise the nearest config file (`e2e.config.ts`, `.mts`, `.js`, or `.mjs`) from `cwd` upward. */
  readonly configPath?: string | undefined;
}

/** A config loaded from a file: what sessions on a project share. A session opened with `engine` has none. */
export type LoadedConfig = ResolvedConfig & { readonly configPath: string };

/** The absolute path of a project's config, found without evaluating it. */
export function locateProjectConfig(options: ProjectOptions): string {
  const { configPath } = discoverConfig(options.cwd, options.configPath);
  if (configPath === undefined) {
    throw missingConfigError(
      options.cwd,
      'pass engine to open_session to open a session without one: {engine: "@e2e-dev/web", app: {url: "<app URL>"}}, or {engine: {package: "@e2e-dev/mobile", options: {platform: "ios"}}, app: {bundleId: "<app>"}}',
    );
  }
  return configPath;
}

/** What `open_session` names to open a session where the project has no config file: the engine's factory call, and the app. */
export interface EngineSession extends FactoryRef {
  /** The target's app: the URL it opens, or the installed app or build a device launches. */
  readonly app?: Pick<TargetApp, 'url' | 'bundleId' | 'appPath'> | undefined;
}

/**
 * The config of a session opened with `engine`: one target on that engine
 * package, with the app the call names and every other setting at its
 * default. The project root is `cwd`. Refused where a config file exists,
 * since that file is what a session on the project loads.
 */
export async function loadEngineConfig(
  options: ProjectOptions & { readonly env: NodeJS.ProcessEnv } & Pick<EngineLookup, 'enginesDir'>,
  session: EngineSession,
): Promise<ResolvedConfig> {
  const { configPath } = discoverConfig(options.cwd, options.configPath);
  if (configPath !== undefined) {
    throw new ConfigurationError(
      'INVALID_ARGUMENT',
      `open_session: engine opens a session where there is no config file, and ${configPath} exists; leave engine out to open one of its targets`,
    );
  }
  const engine = await loadEngine(session, { cwd: options.cwd, enginesDir: options.enginesDir });
  return resolveConfig(
    { targets: [{ engine, ...(session.app === undefined ? {} : { app: session.app }) }] },
    { projectRoot: path.resolve(options.cwd), env: options.env },
  );
}

/**
 * Loads the config at `configPath` (absolute, from `locateProjectConfig`)
 * fresh, down to the files it imports by path: an agent edits the config, a
 * base config it spreads, or opens another project while the server runs,
 * and the next session sees the files as they are now. Every session also
 * gets engine instances of its own, even from a config that spreads a base
 * config. The project root is the config's directory. `graph` names the
 * session's module graph, which the test files it collects share.
 */
export async function loadProjectConfig(configPath: string, env: NodeJS.ProcessEnv, graph: string): Promise<LoadedConfig> {
  const raw = await loadConfigModule(configPath, { graph });
  return { ...resolveConfig(raw, { projectRoot: path.dirname(configPath), configPath, env }), configPath };
}
