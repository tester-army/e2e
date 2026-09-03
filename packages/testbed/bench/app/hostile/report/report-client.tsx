'use client';

import { useState } from 'react';

/**
 * Two long-running actions: a report that takes eight seconds (a spinner,
 * then a result) and a sync whose request never returns (a spinner forever).
 * The first must be waited out; the second must be given up on honestly.
 */
export function ReportClient() {
  const [reportState, setReportState] = useState<'idle' | 'generating' | 'done'>('idle');
  const [result, setResult] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [annualState, setAnnualState] = useState<'idle' | 'generating' | 'done'>('idle');
  const [annual, setAnnual] = useState('');

  return (
    <main>
      <h1>Reports</h1>
      <section aria-label="Export">
        <button
          type="button"
          disabled={reportState === 'generating'}
          onClick={async () => {
            setReportState('generating');
            const response = await fetch('/api/hostile/slow', { method: 'POST' });
            const body = (await response.json()) as { message: string };
            setResult(body.message);
            setReportState('done');
          }}
        >
          Generate report
        </button>
        <p role="status" aria-label="Report status">
          {reportState === 'idle' ? 'No report yet' : reportState === 'generating' ? 'Generating report…' : result}
        </p>
      </section>
      <section aria-label="Annual export">
        <button
          type="button"
          disabled={annualState === 'generating'}
          onClick={async () => {
            setAnnualState('generating');
            const response = await fetch('/api/hostile/slower', { method: 'POST' });
            const body = (await response.json()) as { message: string };
            setAnnual(body.message);
            setAnnualState('done');
          }}
        >
          Generate annual report
        </button>
        <p role="status" aria-label="Annual report status">
          {annualState === 'idle' ? 'No annual report yet' : annualState === 'generating' ? 'Generating annual report… this takes a while' : annual}
        </p>
      </section>
      <section aria-label="Sync">
        <button
          type="button"
          disabled={syncing}
          onClick={() => {
            setSyncing(true);
            void fetch('/api/hostile/hang', { method: 'POST' });
          }}
        >
          Sync with ERP
        </button>
        <p role="status" aria-label="Sync status">
          {syncing ? 'Syncing… this may take a moment' : 'Not synced'}
        </p>
      </section>
    </main>
  );
}
