/** Formats an exact nonnegative USD cent amount. */
export function money(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Invalid amount');
  return '$' + Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0');
}

/** Trims only the ASCII whitespace the editable fields accept. */
export function trimAscii(value) {
  if (typeof value !== 'string') throw new Error('Invalid text');
  const whitespace = '\t\n\v\f\r ';
  let start = 0;
  let end = value.length;
  while (start < end && whitespace.includes(value[start])) start++;
  while (end > start && whitespace.includes(value[end - 1])) end--;
  return value.slice(start, end);
}
