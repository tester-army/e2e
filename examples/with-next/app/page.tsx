import { GreetingForm } from './greeting-form.tsx';

export default function Home() {
  return (
    <div className="page">
      <header className="nav">
        <img src="/e2e-logotype-white.svg" alt="e2e" width={69} height={24} />
      </header>

      <main className="hero">
        <p className="eyebrow">[ with-next ]</p>
        <h1 className="title">say hello</h1>
        <p className="lede">A demo screen for the e2e examples. Type a name and the app greets you.</p>
        <GreetingForm />
      </main>

      <footer className="footer">example app for e2e. the tests live in tests/.</footer>
    </div>
  );
}
