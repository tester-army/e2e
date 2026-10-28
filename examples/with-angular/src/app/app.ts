import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <div class="page">
      <header class="nav">
        <img src="/e2e-lockup-32-white.svg" alt="e2e" width="109" height="32" />
      </header>

      <main class="hero">
        <p class="eyebrow">[01] with-angular</p>
        <h1 class="title">Say hello</h1>
        <p class="lede">A demo screen for the e2e examples. Type a name and the app greets you.</p>

        <form class="form" (submit)="greet($event)">
          <label class="label" for="name">Name</label>
          <div class="row">
            <input
              #field
              id="name"
              class="field"
              autocomplete="off"
              placeholder="Ada Lovelace"
              [value]="name()"
              (input)="name.set(field.value)"
            />
            <button class="button" type="submit">Greet</button>
          </div>
          @if (error()) {
            <p class="error" role="alert">Enter a name first.</p>
          }
          @if (greeted(); as greeted) {
            <p class="status" role="status">Hello, {{ greeted }}!</p>
          }
        </form>
      </main>

      <footer class="footer">Example app for e2e. The tests live in tests/.</footer>
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
