/** Scalar fields shared by trace readers and the recorder. */

/** The configured model identity attached to a recording. */
export interface RecordedModel {
  readonly provider: string;
  readonly model: string;
}

/** Nonblank text within the field's character budget, preserved verbatim. */
export function readBoundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxChars) {
    return undefined;
  }
  return value;
}

/** Malformed optional model attribution never makes a recording unreadable. */
export function readRecordedModel(value: unknown, maxChars: number): RecordedModel | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const provider = readBoundedText(raw['provider'], maxChars);
  const model = readBoundedText(raw['model'], maxChars);
  return provider === undefined || model === undefined ? undefined : { provider, model };
}
