import { NextResponse } from 'next/server';
import { resetHandoff } from '../../../lib/handoff';
import { resetHostile } from '../../../lib/hostile';
import { resetProcure } from '../../../lib/procure';
import { resetStore } from '../../../lib/store';

export async function POST() {
  resetStore();
  resetProcure();
  resetHandoff();
  resetHostile();
  return NextResponse.json({ ok: true });
}
