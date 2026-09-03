import { NextResponse } from 'next/server';
import { applyHostile, readHostile, type HostileCommand } from '../../../lib/hostile';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(readHostile());
}

export async function POST(request: Request) {
  const command = (await request.json()) as HostileCommand;
  return NextResponse.json(applyHostile(command));
}
