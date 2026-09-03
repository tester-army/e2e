'use client';

import { useCallback, useEffect, useState } from 'react';
import type { HostileCommand } from '../../lib/hostile';

export interface HostileView {
  items: { id: number; name: string; folder: string }[];
  savedNote: string;
  consent: boolean;
}

/**
 * Client state for the hostile pages. The list re-fetches on an interval, the
 * way a dashboard polls: a mutation the server has only acknowledged shows up
 * a few seconds later, not on the next render.
 */
export function useHostile(initial: HostileView, pollMs = 1_500) {
  const [view, setView] = useState(initial);
  const [toast, setToast] = useState<string | undefined>();
  const refresh = useCallback(async () => {
    const response = await fetch('/api/hostile');
    setView((await response.json()) as HostileView);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);
  async function apply(command: HostileCommand): Promise<{ ok: boolean; message: string }> {
    const response = await fetch('/api/hostile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
    const result = (await response.json()) as { ok: boolean; message: string };
    setToast(result.message);
    // Toasts vanish: a verdict that needs one has to catch it in time.
    setTimeout(() => setToast(undefined), 2_500);
    void refresh();
    return result;
  }
  return { view, apply, toast, refresh };
}
