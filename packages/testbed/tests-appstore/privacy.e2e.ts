/**
 * Guidelines 5.1.1 (Data Collection and Storage) and 4.8 (Login Services).
 * The `device` fixture arranges the permission state; the agent uses the app
 * and judges what it shows.
 */

import type { DevicePermission } from '@e2edev/agent-device';
import { GUIDELINES, audit, judge, merge } from './audit.ts';

const PERMISSIONS: readonly DevicePermission[] = ['camera', 'microphone', 'photos', 'contacts', 'location', 'notifications', 'calendar'];
const MAX_PROMPTS = 3;

audit('5.1.1(i) a privacy policy is reachable from inside the app', ['guideline:5.1.1'], async (fx, conclude) => {
  await fx.agent.act(
    'find the Privacy Policy: check settings, profile or account, about, help or legal, the sign-in screen, and the paywall if there is one; open it once found and stop; if none of those places has it, stop where you are',
  );
  conclude(
    await judge(
      fx,
      GUIDELINES.privacyPolicy,
      'Privacy policy link reachable in-app',
      'is a privacy policy shown or linked on this screen, or was it just opened? Not finding one after looking in settings, profile, about, help, sign-in, and paywall is a violation, never not-applicable',
    ),
  );
});

audit('5.1.1(iv) stays usable with the tested permissions denied', ['guideline:5.1.1'], async (fx, conclude) => {
  try {
    for (const permission of PERMISSIONS) await fx.device.setPermission(permission, 'deny');
    await fx.app.restart();
    await fx.agent.act(
      'use the app for a few screens the way a new user would, favouring features that would normally need the camera, photo library, location, contacts, or notifications; do not try to change any permission',
    );
    conclude(
      await judge(
        fx,
        GUIDELINES.permissionAccess,
        'Core functionality works with permissions denied',
        'every system permission is denied. Compliant when the main content and features still work, with a calm message or a Settings link where a feature needs access; violation when a wall blocks all use or the app keeps re-asking',
      ),
    );
  } finally {
    for (const permission of PERMISSIONS) await fx.device.setPermission(permission, 'reset');
  }
});

audit('5.1.1(ii) permission prompts say why the app needs the access', ['guideline:5.1.1'], async (fx, conclude) => {
  for (const permission of PERMISSIONS) await fx.device.setPermission(permission, 'reset');
  await fx.app.restart();

  const prompts = [];
  for (let round = 1; round <= MAX_PROMPTS; round += 1) {
    await fx.agent.act(
      'trigger a feature that asks for a system permission not triggered in an earlier step; the moment an iOS permission alert appears, stop without answering it; if nothing within reach asks for a permission, stop where you are',
    );
    const prompt = await judge(
      fx,
      GUIDELINES.permissionPurpose,
      `Permission prompt ${round} explains its purpose`,
      'is an iOS permission alert on screen? not-applicable when none is; compliant when its message says what the app does with the access and how the user benefits; violation when it only says access is needed or shows the system default text',
      { vision: 'fallback' },
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

audit(
  '4.8 and 5.1.1(v): login services, guest access, and account deletion',
  ['guideline:4.8', 'guideline:5.1.1'],
  async (fx, conclude) => {
    await fx.agent.act(
      'find the sign-in or create-account screen: look for Sign in, Log in, Sign up, Account, or Profile; open it and stop; if the app shows you are already signed in, open the profile or account screen instead; if the app has no accounts at all, stop where you are',
    );
    const loginServices = await judge(
      fx,
      GUIDELINES.loginServices,
      'Sign in with Apple offered next to third-party login',
      "which login options are offered? not-applicable when there is no sign-in, or only email and password or the developer's own accounts; compliant when a third-party provider (Google, Facebook, X, Microsoft) is offered alongside Sign in with Apple, or alongside another service that limits data to name and email, lets users hide their email, and does not collect app interactions for advertising without consent; violation when a third-party provider is offered without such an option",
    );
    const loginGate = await judge(
      fx,
      GUIDELINES.loginGate,
      'Usable without creating an account',
      'can the app be used without an account? not-applicable when there is no sign-in; compliant when a skip, guest, or browse option exists or content was usable before this screen; violation when sign-in is required before any use',
    );
    await fx.agent.act(
      'if the app creates accounts and you are signed in, find the option to delete the account (Profile or Settings > Account, Manage account, Privacy) and open the screen that shows it without confirming anything; if a sign-in form you cannot pass is in the way, or the app has no accounts, stop where you are',
    );
    const accountDeletion = await judge(
      fx,
      GUIDELINES.accountDeletion,
      'Account deletion offered in-app',
      'is there an option to delete the account? not-applicable when the app does not create accounts; unverified when a sign-in form blocked the check; compliant when a delete-account option is shown (a link to a web page that completes deletion counts); violation when there is none or the only route is contacting support',
    );
    conclude(loginServices, loginGate, accountDeletion);
  },
);
