import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const cookieStore = await cookies();
  if (cookieStore.get('bench_session')?.value !== 'member') redirect('/login');
  return (
    <main>
      <h1>Dashboard</h1>
      <p>Welcome, member</p>
      <form method="post" action="/api/logout">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
