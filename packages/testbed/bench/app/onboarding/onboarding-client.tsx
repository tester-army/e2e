'use client';

import { useState } from 'react';

/**
 * A six-page onboarding wizard with eighteen fields: one `agent.act` step that
 * has to carry state across many actions and screens. Pure client state — the
 * summary at the end is what a test asserts on.
 */
const PAGES = ['Company', 'Address', 'Billing', 'Team', 'Preferences', 'Review'] as const;

type Fields = Record<string, string>;

const FIELDS: Record<(typeof PAGES)[number], { id: string; label: string; kind?: 'select' | 'checkbox'; options?: string[] }[]> = {
  Company: [
    { id: 'company', label: 'Company name' },
    { id: 'website', label: 'Website' },
    { id: 'industry', label: 'Industry', kind: 'select', options: ['Software', 'Retail', 'Manufacturing', 'Healthcare'] },
    { id: 'size', label: 'Company size', kind: 'select', options: ['1-10', '11-50', '51-200', '201-1000'] },
  ],
  Address: [
    { id: 'street', label: 'Street' },
    { id: 'city', label: 'City' },
    { id: 'postal', label: 'Postal code' },
    { id: 'country', label: 'Country', kind: 'select', options: ['Germany', 'Poland', 'Spain', 'Sweden'] },
  ],
  Billing: [
    { id: 'vat', label: 'VAT number' },
    { id: 'billingEmail', label: 'Billing email' },
    { id: 'currency', label: 'Currency', kind: 'select', options: ['EUR', 'USD', 'PLN', 'SEK'] },
  ],
  Team: [
    { id: 'owner', label: 'Account owner' },
    { id: 'ownerEmail', label: 'Owner email' },
    { id: 'seats', label: 'Seats' },
  ],
  Preferences: [
    { id: 'timezone', label: 'Time zone', kind: 'select', options: ['Europe/Berlin', 'Europe/Warsaw', 'Europe/Madrid', 'Europe/Stockholm'] },
    { id: 'language', label: 'Language', kind: 'select', options: ['English', 'German', 'Polish', 'Spanish'] },
    { id: 'newsletter', label: 'Subscribe to the newsletter', kind: 'checkbox' },
    { id: 'terms', label: 'Accept the terms of service', kind: 'checkbox' },
  ],
  Review: [],
};

export function OnboardingClient() {
  const [page, setPage] = useState(0);
  const [fields, setFields] = useState<Fields>({});
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const current = PAGES[page]!;

  function next() {
    const missing = FIELDS[current].find((field) => field.kind !== 'checkbox' && field.kind !== 'select' && !(fields[field.id] ?? '').trim());
    if (missing !== undefined) {
      setError(`${missing.label} is required`);
      return;
    }
    if (current === 'Preferences' && fields['terms'] !== 'on') {
      setError('You must accept the terms of service');
      return;
    }
    setError(undefined);
    setPage(page + 1);
  }

  return (
    <main>
      <h1>Onboarding</h1>
      <p role="status" aria-label="Progress">
        Step {page + 1} of {PAGES.length}: {current}
      </p>
      {done ? (
        <p role="status" aria-label="Result">
          Onboarding complete for {fields['company']} ({fields['seats']} seats, {fields['currency'] ?? 'EUR'},{' '}
          {fields['timezone'] ?? 'Europe/Berlin'})
        </p>
      ) : current === 'Review' ? (
        <section aria-label="Review">
          <dl>
            {Object.values(FIELDS)
              .flat()
              .map((field) => (
                <div key={field.id}>
                  <dt>{field.label}</dt>
                  <dd>{field.kind === 'checkbox' ? (fields[field.id] === 'on' ? 'yes' : 'no') : fields[field.id] ?? (field.options?.[0] ?? '')}</dd>
                </div>
              ))}
          </dl>
          <button type="button" onClick={() => setDone(true)}>
            Finish onboarding
          </button>
          <button type="button" onClick={() => setPage(page - 1)}>
            Back
          </button>
        </section>
      ) : (
        <section aria-label={current}>
          <h2>{current}</h2>
          {FIELDS[current].map((field) =>
            field.kind === 'select' ? (
              <div key={field.id}>
                <label htmlFor={field.id}>{field.label}</label>
                <select
                  id={field.id}
                  value={fields[field.id] ?? field.options![0]}
                  onChange={(event) => setFields({ ...fields, [field.id]: event.target.value })}
                >
                  {field.options!.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              </div>
            ) : field.kind === 'checkbox' ? (
              <div key={field.id}>
                <input
                  id={field.id}
                  type="checkbox"
                  checked={fields[field.id] === 'on'}
                  onChange={(event) => setFields({ ...fields, [field.id]: event.target.checked ? 'on' : 'off' })}
                />
                <label htmlFor={field.id}>{field.label}</label>
              </div>
            ) : (
              <div key={field.id}>
                <label htmlFor={field.id}>{field.label}</label>
                <input
                  id={field.id}
                  value={fields[field.id] ?? ''}
                  onChange={(event) => setFields({ ...fields, [field.id]: event.target.value })}
                />
              </div>
            ),
          )}
          {error === undefined ? null : (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {page > 0 ? (
            <button type="button" onClick={() => setPage(page - 1)}>
              Back
            </button>
          ) : null}
          <button type="button" onClick={next}>
            Continue
          </button>
        </section>
      )}
    </main>
  );
}
