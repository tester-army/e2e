import { NextResponse } from 'next/server';
import { resetStore } from '../../../lib/store';

export async function POST() {
  resetStore();
  return NextResponse.json({ ok: true });
}
