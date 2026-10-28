import type { Locator, Screen, Secret } from 'e2e';

export class SignInPage {
  readonly email: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  readonly error: Locator;

  constructor(readonly screen: Screen) {
    this.email = screen.getByLabel('Email');
    this.password = screen.getByLabel('Password');
    this.submit = screen.getByRole('button', 'Sign in');
    this.error = screen.getByRole('alert');
  }

  async signIn(email: string, password: string | Secret) {
    await this.email.fill(email);
    await this.password.fill(password);
    await this.submit.tap();
  }
}
