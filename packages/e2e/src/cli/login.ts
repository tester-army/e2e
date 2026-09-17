/**
 * `e2e login` and `e2e logout`: sign in to a personal subscription
 * (ChatGPT Plus/Pro, GitHub Copilot, SuperGrok) so a config can construct
 * its model from `@e2edev/oauth`. The flows live in that package; the CLI
 * only forwards to it, resolved from the project so the runner itself never
 * depends on any provider.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';

export interface LoginOptions {
  readonly device?: boolean;
  readonly clientId?: string;
  readonly fromGh?: boolean;
  readonly enterpriseUrl?: string;
}

type OAuthCliModule = { runOAuthCli(argv: readonly string[]): Promise<number> };

/** Loads `@e2edev/oauth/cli` from the project, or explains how to add it. */
async function loadOAuthCli(cwd: string): Promise<OAuthCliModule | undefined> {
  const require = createRequire(path.join(cwd, 'package.json'));
  let resolved: string;
  try {
    resolved = require.resolve('@e2edev/oauth/cli');
  } catch {
    process.stderr.write(
      `${pc.red('error:')} @e2edev/oauth is not installed in this project. Add it with ${pc.cyan('npm i -D @e2edev/oauth')}, then import a model from it in e2e.config.ts, e.g. ${pc.cyan("import { chatgpt } from '@e2edev/oauth/chatgpt'")}.\n`,
    );
    return undefined;
  }
  return (await import(pathToFileURL(resolved).href)) as OAuthCliModule;
}

export async function login(cwd: string, provider: string, options: LoginOptions): Promise<number> {
  const cli = await loadOAuthCli(cwd);
  if (cli === undefined) return 1;
  return cli.runOAuthCli([
    'login',
    provider,
    ...(options.device === true ? ['--device'] : []),
    ...(options.clientId === undefined ? [] : ['--client-id', options.clientId]),
    ...(options.fromGh === true ? ['--from-gh'] : []),
    ...(options.enterpriseUrl === undefined ? [] : ['--enterprise-url', options.enterpriseUrl]),
  ]);
}

export async function logout(cwd: string, provider: string | undefined): Promise<number> {
  const cli = await loadOAuthCli(cwd);
  if (cli === undefined) return 1;
  return cli.runOAuthCli(provider === undefined ? ['status'] : ['logout', provider]);
}
