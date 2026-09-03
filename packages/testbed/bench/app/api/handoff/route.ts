import { NextResponse } from 'next/server';
import { jitter } from '../../../lib/jitter';
import { enterGate, issueTicket, readHandoff } from '../../../lib/handoff';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(readHandoff());
}

export async function POST(request: Request) {
  await jitter();
  const body = (await request.json()) as { type: 'issue' } | { type: 'enter'; code: string; colour: string; desk: string };
  if (body.type === 'issue') return NextResponse.json(issueTicket());
  return NextResponse.json(enterGate(body.code, body.colour, body.desk));
}
