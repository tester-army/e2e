'use client';

import { useState } from 'react';

export function SettingsClient() {
  const [plan, setPlan] = useState<'Free' | 'Pro'>('Free');
  const [confirming, setConfirming] = useState(false);

  return (
    <main>
      <h1>Settings</h1>
      <p role="status">Plan: {plan}</p>
      <button type="button" onClick={() => setConfirming(true)}>
        Upgrade to Pro
      </button>
      {confirming ? (
        <div className="panel" role="group" aria-label="Confirm upgrade">
          <p>Upgrade to the Pro plan?</p>
          <button
            type="button"
            onClick={() => {
              setPlan('Pro');
              setConfirming(false);
            }}
          >
            Confirm upgrade
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : null}
    </main>
  );
}
