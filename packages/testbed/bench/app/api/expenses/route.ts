import { NextResponse } from 'next/server';
import { addExpense } from '../../../lib/store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json();
  const category = body.category === 'Meals' || body.category === 'Office' ? body.category : 'Travel';
  const title = String(body.title ?? '').trim();
  const amount = Number(body.amount ?? 0);
  return NextResponse.json(addExpense({ title, amount, category }), { status: 201 });
}
