import { NextResponse } from 'next/server';
import { jitter } from '../../../lib/jitter';
import { applyProcure, readProcure, type ProcureCommand } from '../../../lib/procure';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(readProcure());
}

export async function POST(request: Request) {
  await jitter();
  const command = (await request.json()) as ProcureCommand;
  return NextResponse.json(applyProcure(command));
}
