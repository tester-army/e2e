import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Answers after eight seconds: a slow report, longer than any settle budget. */
export async function POST() {
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  return NextResponse.json({ ok: true, message: 'Report ready: 12 rows exported' });
}
