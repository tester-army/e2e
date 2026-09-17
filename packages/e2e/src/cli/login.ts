/**
 * `e2e login` and `e2e logout`: sign in to a personal subscription
 * (ChatGPT Plus/Pro, GitHub Copilot, SuperGrok) so a config can construct
 * its model from `@e2edev/oauth`. The flows live in that package; the CLI
 * calls its typed entry points, resolved from the project so the runner
 * itself never depends on any provider.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';

/** The providers `@e2edev/oauth` signs in to; commander rejects anything else as a usage error. */
export const LOGIN_PROVIDERS = ['openai', 'github-copilot', 'xai'] as const;

export interface LoginOptions {
  readonly device?: boolean;
  readonly clientId?: string;
  readonly fromGh?: boolean;
  readonly enterpriseUrl?: string;
}

/** What `@e2edev/oauth/cli` exports; typed here because the runner cannot import the package. */
interface OAuthCli {
  runLogin(providerId: string, options: { method?: 'device'; clientId?: string; fromGitHubCli?: boolean; enterpriseUrl?: string }): Promise<number>;
  runLogout(providerId: string): Promise<number>;
  runStatus(): Promise<number>;
}

/** Loads `@e2edev/oauth/cli` from the project, or explains how to add it. */
async function loadOAuthCli(cwd: string): Promise<OAuthCli | undefined> {
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
  return (await import(pathToFileURL(resolved).href)) as OAuthCli;
}

/** Signs in to `provider`, or without one lists the stored logins. */
export async function login(cwd: string, provider: string | undefined, options: LoginOptions): Promise<number> {
  const cli = await loadOAuthCli(cwd);
  if (cli === undefined) return 1;
  if (provider === undefined) return cli.runStatus();
  return cli.runLogin(provider, {
    ...(options.device === true ? { method: 'device' } : {}),
    ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
    ...(options.fromGh === true ? { fromGitHubCli: true } : {}),
    ...(options.enterpriseUrl === undefined ? {} : { enterpriseUrl: options.enterpriseUrl }),
  });
}

export async function logout(cwd: string, provider: string): Promise<number> {
  const cli = await loadOAuthCli(cwd);
  if (cli === undefined) return 1;
  return cli.runLogout(provider);
}
