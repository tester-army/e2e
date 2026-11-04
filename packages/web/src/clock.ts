import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';

/** The browser clock installed before each context opens its first document. */
export interface WebClock {
  /** A date string or milliseconds since the Unix epoch. */
  readonly time: string | number;
  /** Advance at real speed by default; `paused` stops the clock and page timers. */
  readonly mode?: 'running' | 'paused';
}

/** Rejects an invalid clock before a browser launches. */
export function validateClock(clock: unknown): void {
  if (typeof clock !== 'object' || clock === null || Array.isArray(clock)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ clock }) must be an object: { time, mode? }');
  }
  rejectUnknownKeys('web({ clock })', clock, ['time', 'mode']);
  const time: unknown = Reflect.get(clock, 'time');
  const timestamp = typeof time === 'string' ? Date.parse(time) : typeof time === 'number' ? time : NaN;
  if (!Number.isFinite(new Date(timestamp).getTime())) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ clock }) time must be a valid date string or a timestamp in milliseconds');
  }
  const mode: unknown = Reflect.get(clock, 'mode');
  if (mode !== undefined && mode !== 'running' && mode !== 'paused') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ clock }) mode must be "running" or "paused"');
  }
}
