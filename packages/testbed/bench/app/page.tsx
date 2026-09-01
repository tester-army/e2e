import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>Bench</h1>
      <p>A deterministic playground for benchmarking agentic test runs.</p>
      <nav aria-label="Pages">
        <ul>
          <li>
            <Link href="/login">Login</Link>
          </li>
          <li>
            <Link href="/dashboard">Dashboard</Link>
          </li>
          <li>
            <Link href="/expenses">Expenses</Link>
          </li>
          <li>
            <Link href="/stale">Stale DOM</Link>
          </li>
          <li>
            <Link href="/settings">Settings</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
