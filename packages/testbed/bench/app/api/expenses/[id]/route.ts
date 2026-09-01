import { NextResponse } from 'next/server';
import { removeExpense, toggleApproved } from '../../../../lib/store';

export async function PATCH(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(toggleApproved(Number(id)));
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(removeExpense(Number(id)));
}
