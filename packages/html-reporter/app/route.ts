/**
 * The page's state lives in the URL hash (`#?status=failed&q=login`,
 * `#?test=<result id>&attempt=2`), so the back button works and a link
 * points at the same view. A hash never reaches a server, and works on
 * `file://`.
 */

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

const readHash = () => window.location.hash;

/** The hash's query parameters, re-read on every hash change. */
export function useRoute(): URLSearchParams {
  return new URLSearchParams(useSyncExternalStore(subscribe, readHash).replace(/^#\??/u, ''));
}

/** The hash link for these parameters, empty values left out. */
export function routeHref(params: Readonly<Record<string, string | undefined>>): string {
  const query = new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (value === undefined || value === '' ? [] : [[key, value]])));
  return `#?${query.toString()}`;
}

/** Replaces the hash without adding a history entry: typing in the search box. */
export function replaceRoute(params: Readonly<Record<string, string | undefined>>): void {
  window.history.replaceState(null, '', routeHref(params));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
