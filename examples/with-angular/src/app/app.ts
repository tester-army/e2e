import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <div class="page">
      <header class="nav">
        <img src="/e2e-logotype-white.svg" alt="e2e" width="69" height="24" />
      </header>

      <main class="hero">
        <p class="eyebrow">[ with-angular ]</p>
        <h1 class="title">say hello</h1>
        <p class="lede">A demo screen for the e2e examples. Type a name and the app greets you.</p>

        <form class="form" (submit)="greet($event)">
          <div class="field">
            <input
              #field
              id="name"
              class="field-input"
              autocomplete="off"
              [attr.aria-invalid]="error()"
              [value]="name()"
              (input)="name.set(field.value)"
            />
            <label class="field-label" for="name">name</label>
          </div>
          <button class="button" type="submit">greet</button>
          @if (error()) {
            <p class="error" role="alert">enter a name first.</p>
          }
          @if (greeted(); as greeted) {
            <p class="status" role="status">hello, {{ greeted }}!</p>
          }
        </form>
      </main>

      <footer class="footer">example app for e2e. the tests live in tests/.</footer>
    </div>
  `,
})
export class App {
  protected readonly name = signal('');
  protected readonly error = signal(false);
  protected readonly greeted = signal<string | null>(null);

  protected greet(event: Event) {
    event.preventDefault();
    const value = this.name().trim();
    if (value === '') {
      this.error.set(true);
      this.greeted.set(null);
      return;
    }
    this.error.set(false);
    this.greeted.set(value);
    this.name.set('');
  }
}
