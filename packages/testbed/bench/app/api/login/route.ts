import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const form = await request.formData();
  const username = form.get('username');
  const password = form.get('password');
  if (username === 'member' && password === 'bench-password-1') {
    const response = NextResponse.redirect(new URL('/dashboard', request.url), 303);
    response.cookies.set('bench_session', 'member', { httpOnly: true, path: '/' });
    return response;
  }
  return NextResponse.redirect(new URL('/login?error=1', request.url), 303);
}
