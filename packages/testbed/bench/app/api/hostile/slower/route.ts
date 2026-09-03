import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Answers after twenty-five seconds: slow, but fine — a run must wait, not give up. */
export async function POST() {
  await new Promise((resolve) => setTimeout(resolve, 25_000));
  return NextResponse.json({ ok: true, message: 'Annual report ready: 480 rows exported' });
}
