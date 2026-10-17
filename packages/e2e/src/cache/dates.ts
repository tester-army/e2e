/** Dates and clock times in any language and digits: the volatile text (`anchors.ts`) that needs month names. */

import { escapeRegexpChar } from '../internal/regexp.ts';

/** Digits in any script, with an optional right-to-left mark; `\d` and `\b` are ASCII-only. */
function digits(min: number, max: number): string {
  return String.raw`\p{Nd}{${String(min)},${String(max)}}[\u061c\u200e\u200f]?`;
}

/** A year: in ASCII digits only one that reads as a year (`2026`, Buddhist `2569`), so `25 des 1500` is no date. */
const YEAR = String.raw`(?:(?:19|20|25)[0-9]{2}|(?:(?![0-9])\p{Nd}){4})[\u061c\u200e\u200f]?`;

/** Not inside a word or a number. */
const OPEN = String.raw`(?<![\p{L}\p{M}\p{N}.,])`;

/** Not followed by a word or more of the number. */
const CLOSE = String.raw`(?![\p{L}\p{M}\p{N}]|[./:-]\p{N})`;

/** Languages whose month names count, with the regional variants that name months differently. */
const LANGUAGES = [
  'af', 'am', 'ar', 'ar-DZ', 'ar-MA', 'ar-SY', 'ar-TN', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'es',
  'et', 'eu', 'fa', 'fi', 'fil', 'fr', 'fr-CA', 'ga', 'gl', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'ka', 'kk',
  'km', 'kn', 'ko', 'ky', 'lo', 'lt', 'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'my', 'nb', 'ne', 'nl', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru',
  'si', 'sk', 'sl', 'sq', 'sr', 'sr-Latn', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'zh', 'zu',
];

/** The letters of a literal part that touch the month (`ב` in `8 בספטמבר`), or none. */
function glued(part: Intl.DateTimeFormatPart | undefined, letters: RegExp): string {
  return part?.type === 'literal' ? (letters.exec(part.value)?.[0] ?? '') : '';
}

/** Words as one alternation, longest first, each matched whole. */
function alternation(words: ReadonlySet<string>): string {
  const source = (word: string) => word.split(/\s+/u).map((part) => [...part].map(escapeRegexpChar).join('')).join(String.raw`\s+`);
  return String.raw`(?:${[...words].toSorted((a, b) => b.length - a.length).map(source).join('|')})(?![\p{L}\p{M}])`;
}

/**
 * The month names the languages write in a full date, long and short with
 * the letters glued to them (`בספטמבר`), and the words around them (`de`,
 * `gada`, `พ.ศ.`).
 */
function vocabulary(): { readonly month: string; readonly connector: string } {
  const months = new Set<string>();
  const connectors = new Set<string>();
  for (const language of LANGUAGES) {
    for (const month of ['long', 'short'] as const) {
      const format = new Intl.DateTimeFormat(language, { day: 'numeric', month, year: 'numeric', timeZone: 'UTC' });
      for (let index = 0; index < 12; index += 1) {
        const parts = format.formatToParts(Date.UTC(2026, index, 8));
        const at = parts.findIndex((part) => part.type === 'month');
        const name = parts[at];
        if (name === undefined || !/\p{L}/u.test(name.value)) continue;
        months.add(`${glued(parts[at - 1], /\p{L}+$/u)}${name.value}${glued(parts[at + 1], /^\p{L}+/u)}`.toLocaleLowerCase());
      }
    }
    for (const options of [{ day: 'numeric', month: 'long', year: 'numeric' }, { dateStyle: 'full' }] as const) {
      for (const part of new Intl.DateTimeFormat(language, { ...options, timeZone: 'UTC' }).formatToParts(Date.UTC(2026, 8, 8))) {
        if (part.type !== 'literal' && part.type !== 'era') continue;
        for (const word of part.value.match(/\p{L}[\p{L}\p{M}.]*/gu) ?? []) connectors.add(word.toLocaleLowerCase());
      }
    }
  }
  return { month: alternation(months), connector: alternation(connectors) };
}

/** Builds the patterns; reading the month names from `Intl` takes about 50 ms, so build them once. */
export function datePatterns(): RegExp[] {
  const { month, connector } = vocabulary();
  return [
    new RegExp(String.raw`(?<!\p{N}:?)${digits(1, 2)}:${digits(2, 2)}(?::${digits(2, 2)})?(?!:?\p{N})`, 'u'),
    new RegExp(
      String.raw`${OPEN}(?:${digits(1, 2)}/${digits(1, 2)}/(?:${YEAR}|${digits(2, 2)})|${digits(1, 2)}-${digits(1, 2)}-${YEAR}|${YEAR}[/-]${digits(1, 2)}[/-]${digits(1, 2)})${CLOSE}`,
      'u',
    ),
    // A full year or two-digit parts, so a version (`2.2.1`) stays stable.
    new RegExp(
      String.raw`${OPEN}(?:${digits(1, 2)}\.\s?${digits(1, 2)}\.\s?${YEAR}|${YEAR}\.\s?${digits(1, 2)}\.\s?${digits(1, 2)}|${digits(2, 2)}\.${digits(2, 2)}\.${digits(2, 2)}|${digits(2, 2)}\.\s${digits(1, 2)}\.\s${digits(1, 2)}\.)${CLOSE}`,
      'u',
    ),
    new RegExp(String.raw`${digits(1, 4)}\s?[年년]\s?${digits(1, 2)}\s?[月월](?:\s?${digits(1, 2)}\s?[日일])?|${digits(1, 2)}\s?[月월]\s?${digits(1, 2)}\s?[日일]`, 'u'),
    new RegExp(String.raw`${OPEN}${digits(1, 2)}\.?,?\s+(?:${connector}\s+)?${month}\.?[,،]?(?:\s+${connector})?[,،]?\s+${YEAR}${CLOSE}`, 'iu'),
    new RegExp(String.raw`${OPEN}${YEAR}\.?(?:\s+${connector})?\s+(?:${month}\s+${digits(1, 2)}|${digits(1, 2)}\.?\s+${month})${CLOSE}`, 'iu'),
  ];
}
