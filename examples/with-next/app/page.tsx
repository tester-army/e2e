import { GreetingForm } from './greeting-form.tsx';

export default function Home() {
  return (
    <div className="page">
      <header className="nav">
        <img src="/e2e-lockup-32-white.svg" alt="e2e" width={109} height={32} />
      </header>

      <main className="hero">
        <p className="eyebrow">[01] with-next</p>
        <h1 className="title">Say hello</h1>
        <p className="lede">A demo screen for the e2e examples. Type a name and the app greets you.</p>
        <GreetingForm />
      </main>

      <footer className="footer">Example app for e2e. The tests live in tests/.</footer>
    </div>
  );
}
