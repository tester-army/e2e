export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main>
      <h1>Sign in</h1>
      {error === undefined ? null : (
        <p className="error" role="alert">
          Invalid credentials
        </p>
      )}
      <form method="post" action="/api/login">
        <label htmlFor="username">Username</label>
        <input id="username" name="username" autoComplete="username" />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
