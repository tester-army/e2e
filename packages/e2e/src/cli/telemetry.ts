/** `e2e telemetry`: whether anonymous usage telemetry is on, and the switch. */

import picocolors from 'picocolors';
import type { Telemetry, TelemetryDisabledBy } from '../telemetry/telemetry.ts';
import { DOCS_URL } from './docs-url.ts';

export type TelemetryAction = 'status' | 'enable' | 'disable';

export const TELEMETRY_ACTIONS: readonly TelemetryAction[] = ['status', 'enable', 'disable'];

const REASONS: Readonly<Record<TelemetryDisabledBy, string>> = {
  E2E_TELEMETRY_DISABLED: 'E2E_TELEMETRY_DISABLED is set',
  DO_NOT_TRACK: 'DO_NOT_TRACK is set',
  checkout: 'running from a source checkout of e2e',
  preference: 'switched off with e2e telemetry disable',
  store: 'the preferences directory is not writable',
};

/**
 * Applies `enable` or `disable`, then prints the status either way, so the
 * user sees the result of the switch together with anything that still
 * overrides it, such as a variable set in the shell. Exit 2 only when a
 * choice could not be saved.
 */
export function telemetry(action: TelemetryAction, instance: Telemetry): number {
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  if (action !== 'status') {
    const enable = action === 'enable';
    const saved = instance.setEnabled(enable);
    if (saved === undefined) {
      process.stderr.write(`the choice could not be saved: ${instance.preferencesPath} is not writable\n`);
      return 2;
    }
    out(`telemetry ${enable ? 'enabled' : 'disabled'}; saved to ${saved}`);
  }
  const disabledBy = instance.disabledBy;
  if (disabledBy === undefined) {
    out(`Status: ${picocolors.green('enabled')}`);
    out('Anonymous usage data is sent: the command, the versions, the OS, and run counts. Never test names, app data, or credentials.');
  } else {
    out(`Status: ${picocolors.red('disabled')} (${REASONS[disabledBy]})`);
    out('Nothing is sent from this machine.');
  }
  out(`Details: ${DOCS_URL}/telemetry`);
  return 0;
}
