/**
 * The environment a test that launches a real browser hands to `init`:
 * only the sandbox flag, forwarded from the ambient shell. The engine
 * reads the flag from the run's environment only, so the workflow opt-out
 * (`E2E_CHROMIUM_SANDBOX=0` on a host whose sandbox cannot start) reaches
 * the launch this way; nothing else from the process environment leaks in.
 */
export function browserTestEnv(): Record<string, string | undefined> {
  return { E2E_CHROMIUM_SANDBOX: process.env['E2E_CHROMIUM_SANDBOX'] };
}
