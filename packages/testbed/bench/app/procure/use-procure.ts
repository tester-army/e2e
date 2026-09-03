'use client';

import { useState } from 'react';
import type { ProcureCommand, ProcureState } from '../../lib/procure';

/** Client-side handle on the shared server store: every mutation re-renders from the server's answer. */
export function useProcure(initial: ProcureState) {
  const [state, setState] = useState(initial);
  async function apply(command: ProcureCommand): Promise<void> {
    const response = await fetch('/api/procure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
    setState((await response.json()) as ProcureState);
  }
  return { state, apply };
}
