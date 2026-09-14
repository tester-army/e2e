/**
 * Guideline 5.1.1 (Data Collection and Storage): privacy policy, permissions,
 * and account deletion.
 * The `device` fixture arranges the permission state; the agent uses the app
 * and judges what it shows.
 */

import type { Device, DevicePermission } from '@e2edev/agent-device';
import { GUIDELINES, audit, judge, merge, reach, unverified } from './audit.ts';

const PERMISSIONS: readonly DevicePermission[] = ['camera', 'microphone', 'photos', 'contacts', 'location', 'notifications', 'calendar'];
const MAX_PROMPTS = 3;

/**
 * Puts every tested permission into `state` and returns the ones this
 * simulator runtime can set; `simctl privacy` knows no camera or
 * notifications service, and a check must say which permissions it covered.
 */
async function setPermissions(device: Device, state: 'deny' | 'reset'): Promise<readonly DevicePermission[]> {
  const applied: DevicePermission[] = [];
  for (const permission of PERMISSIONS) {
    try {
      await device.setPermission(permission, state);
      applied.push(permission);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'UNSUPPORTED_CAPABILITY') throw error;
    }
  }
  return applied;
}

audit('5.1.1(i) a privacy policy is reachable from inside the app', ['guideline:5.1.1'], async (fx, conclude) => {
  const note = await reach(
    fx,
    'find the Privacy Policy: check settings, profile or account, about, help or legal, the sign-in screen, and the paywall if there is one; open it once found and stop; if none of those places has it, stop where you are',
  );
  conclude(
    await judge(
      fx,
      GUIDELINES.privacyPolicy,
      'Privacy policy link reachable in-app',
      'is a privacy policy shown or linked on this screen, or was it just opened? Not finding one after looking in settings, profile, about, help, sign-in, and paywall is a violation, never not-applicable',
      { note },
    ),
  );
});

audit('5.1.1(iv) stays usable with the tested permissions denied', ['guideline:5.1.1'], async (fx, conclude) => {
  const check = 'Core functionality works with permissions denied';
  try {
    const denied = await setPermissions(fx.device, 'deny');
    if (denied.length === 0) {
      conclude(await unverified(fx, GUIDELINES.permissionAccess, check, 'this simulator runtime cannot deny any of the tested permissions'));
      return;
    }
    await fx.app.restart();
    const note = await reach(
      fx,
      'use the app for a few screens the way a new user would, favouring features that would normally need the camera, photo library, location, contacts, or notifications; do not try to change any permission',
    );
    conclude(
      await judge(
        fx,
        GUIDELINES.permissionAccess,
        check,
        `these system permissions are denied: ${denied.join(', ')}. Compliant when the main content and features still work, with a calm message or a Settings link where a feature needs access; violation when a wall blocks all use or the app keeps re-asking`,
        { note },
      ),
    );
  } finally {
    await setPermissions(fx.device, 'reset');
  }
});

audit('5.1.1(ii) permission prompts say why the app needs the access', ['guideline:5.1.1'], async (fx, conclude) => {
  await setPermissions(fx.device, 'reset');
  await fx.app.restart();

  const prompts = [];
  for (let round = 1; round <= MAX_PROMPTS; round += 1) {
    const note = await reach(
      fx,
      'trigger a feature that asks for a system permission not triggered in an earlier step; the moment an iOS permission alert appears, stop without answering it; if nothing within reach asks for a permission, stop where you are',
    );
    const prompt = await judge(
      fx,
      GUIDELINES.permissionPurpose,
      `Permission prompt ${round} explains its purpose`,
      'is an iOS permission alert on screen? not-applicable when none is; compliant when its message says what the app does with the access and how the user benefits; violation when it only says access is needed or shows the system default text',
      { vision: true, note },
    );
    prompts.push(prompt);
    if (prompt.verdict === 'not-applicable') break;
    await fx.device.alert('dismiss');
  }

  const seen = prompts.filter((prompt) => prompt.verdict !== 'not-applicable').length;
  conclude(
    merge(
      prompts,
      'Permission prompts explain their purpose',
      seen === 0 ? 'No permission prompt was reached from the main screens' : `${seen} prompt(s) explain what the access is for`,
    ),
  );
});

audit('5.1.1(v) account deletion is offered in-app', ['guideline:5.1.1'], async (fx, conclude) => {
  const note = await reach(
    fx,
    'if the app creates accounts and you are signed in, find the option to delete the account (Profile or Settings > Account, Manage account, Privacy) and open the screen that shows it without confirming anything; if a sign-in form you cannot pass is in the way, or the app has no accounts, stop where you are',
  );
  conclude(
    await judge(
      fx,
      GUIDELINES.accountDeletion,
      'Account deletion offered in-app',
      'is there an option to delete the account? not-applicable when the app does not create accounts; unverified when a sign-in form blocked the check; compliant when a delete-account option is shown (a link to a web page that completes deletion counts); violation when there is none or the only route is contacting support',
      { note },
    ),
  );
});
