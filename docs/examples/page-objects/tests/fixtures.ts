import { test as base } from 'e2e';
import { SignInPage } from './pages/sign-in-page.ts';

export const test = base.extend<{ signInPage: SignInPage }>({
  signInPage: async ({ screen }, use) => {
    await use(new SignInPage(screen));
  },
});
