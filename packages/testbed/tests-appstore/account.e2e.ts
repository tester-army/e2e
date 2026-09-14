/**
 * Guidelines 4.8 (Login Services) and 5.1.1(v) (guest access): what the
 * sign-in screen offers. First by file order on purpose: it ends by signing
 * in with the reviewer account when one is configured, and the app keeps
 * that session on the simulator for every check that follows.
 */

import { GUIDELINES, audit, judge, reach, signIn } from './audit.ts';

audit('4.8 and 5.1.1(v): login services and guest access on the sign-in screen', ['guideline:4.8', 'guideline:5.1.1'], async (fx, conclude) => {
  const note = await reach(
    fx,
    'find the sign-in or create-account screen: look for Sign in, Log in, Sign up, Account, or Profile; open it and stop; if the app shows you are already signed in, open the profile or account screen instead; if the app has no accounts at all, stop where you are',
  );
  const loginServices = await judge(
    fx,
    GUIDELINES.loginServices,
    'Sign in with Apple offered next to third-party login',
    "which login options are offered? not-applicable when there is no sign-in, or only email and password or the developer's own accounts; compliant when a third-party provider (Google, Facebook, X, Microsoft) is offered alongside Sign in with Apple, or alongside another service that limits data to name and email, lets users hide their email, and does not collect app interactions for advertising without consent; violation when a third-party provider is offered without such an option; unverified when the app is signed in and its sign-in screen cannot be seen from here",
    { note },
  );
  const loginGate = await judge(
    fx,
    GUIDELINES.loginGate,
    'Usable without creating an account',
    'can the app be used without an account? not-applicable when there is no sign-in; compliant when a skip, guest, or browse option exists or content was usable before this screen; violation when sign-in is required before any use; unverified when the app is already signed in and the sign-in screen cannot be seen from here',
    { note },
  );
  await signIn(fx);
  conclude(loginServices, loginGate);
});
