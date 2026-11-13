/** Date and clock-time patterns. */

/** A month by name or abbreviation, with or without a trailing period. */
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;

/** A day of the month (1-31), with an optional English ordinal suffix (st, nd, rd, th). */
const DAY = String.raw`\d{1,2}(?:st|nd|rd|th)?`;

/** An ISO 8601 calendar date (`YYYY-MM-DD`). */
export const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

/** A clock time (`HH:MM` or `HH:MM:SS`). */
export const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;

/** A month followed by day with optional year (e.g. `October 26th`, `Sep 8, 2026`). */
export const MONTH_DAY_DATE = new RegExp(String.raw`\b${MONTH}\s+${DAY}(?:,?\s+\d{4})?\b`, 'i');

/** A day followed by month with optional year (e.g. `3rd October`, `26th Oct 2026`). */
export const DAY_MONTH_DATE = new RegExp(String.raw`\b${DAY}\s+${MONTH}(?:,?\s+\d{4})?\b`, 'i');
