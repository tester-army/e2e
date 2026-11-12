import { useEffect, useState } from 'react';
import { formatDuration, type ReportError, type ReportModel, type Step } from './data.ts';

type Source = NonNullable<Step['source']>;

/**
 * An error the way it reads best: its code and where it was thrown, the
 * first line of its message, the locator with the expected and received
 * values (the characters that differ marked), and the test code around the
 * failing call.
 */
export function ErrorBlock({
  error,
  model,
  source = error.source,
  secondary = false,
  prompt,
}: {
  error: ReportError;
  model: ReportModel;
  /** Where the frame points: the failing call when the caller knows it, else where the error was thrown. */
  source?: Source | undefined;
  secondary?: boolean;
  prompt?: () => string;
}) {
  const [headline = '', ...rest] = error.message.split('\n');
  const facts = errorFacts(error, rest);
  return (
    <section
      aria-label={secondary ? 'Also failed' : 'Error'}
      className={`flex flex-col gap-e2e-2 border-l-2 bg-shade-800 p-e2e-2 ${secondary ? 'border-shade-600' : 'border-status-failed'}`}
    >
      <span className="type-caption flex flex-wrap items-baseline gap-x-e2e-2 normal-case">
        <span className={secondary ? 'text-shade-400' : 'text-status-failed'}>{error.code}</span>
        {error.source === undefined ? null : (
          <span className="text-shade-500">
            {error.source.file}:{error.source.line}
          </span>
        )}
        {secondary ? <span className="text-shade-500">also failed</span> : null}
        {prompt === undefined ? null : <CopyPrompt prompt={prompt} />}
      </span>
      <p className="type-code-s text-shade-100">{headline}</p>
      {facts.rows.length === 0 ? null : <FactTable rows={facts.rows} />}
      {facts.text.length === 0 ? null : <pre className="type-code-s whitespace-pre-wrap text-shade-300">{facts.text.join('\n')}</pre>}
      {source === undefined ? null : <CodeFrame source={source} model={model} failed />}
    </section>
  );
}

interface FactRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'expected' | 'received';
  /** The value to mark this one's differing characters against. */
  readonly against?: string;
}

/**
 * The error's facts as labelled rows: its structured details when the runner
 * sent them, else the `expected:` and `observed:` lines of its message. The
 * message lines the rows restate are left out of the text.
 */
function errorFacts(error: ReportError, lines: readonly string[]): { rows: FactRow[]; text: string[] } {
  const { details } = error;
  const fromMessage = (key: string) => lines.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2);
  const expected = details?.expected ?? fromMessage('expected');
  // The message adds the match count to the observed line; the row shows it on its own.
  const received = details?.observed ?? fromMessage('observed')?.replace(/ \(match count \d+\)$/u, '');
  const locator = details?.locator ?? fromMessage('locator');
  const rows: FactRow[] = [
    ...(locator === undefined ? [] : [{ label: 'locator', value: locator }]),
    ...(expected === undefined ? [] : [{ label: 'expected', value: expected, tone: 'expected' as const, ...(received === undefined ? {} : { against: received }) }]),
    ...(received === undefined ? [] : [{ label: 'received', value: received, tone: 'received' as const, ...(expected === undefined ? {} : { against: expected }) }]),
    ...(details?.matches === undefined || expected === undefined ? [] : [{ label: 'matches', value: String(details.matches) }]),
    ...(details?.waitedMs === undefined ? [] : [{ label: 'waited', value: formatDuration(details.waitedMs) }]),
  ];
  const restated = /^(?:locator|expected|observed): /u;
  return { rows, text: lines.filter((line) => !restated.test(line) && line.trim() !== '') };
}

function FactTable({ rows }: { rows: readonly FactRow[] }) {
  return (
    <dl className="type-code-s grid grid-cols-[max-content_minmax(0,1fr)] gap-x-e2e-3 gap-y-e2e-half">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-shade-500">{row.label}</dt>
          <dd className={`break-words ${row.tone === 'expected' ? 'text-status-passed' : row.tone === 'received' ? 'text-status-failed' : 'text-shade-200'}`}>
            {row.against === undefined ? row.value : <Marked text={row.value} against={row.against} tone={row.tone} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** `text` with the characters `against` does not share marked, the way a test diff reads. */
function Marked({ text, against, tone }: { text: string; against: string; tone: FactRow['tone'] }) {
  const mark = tone === 'expected' ? 'bg-status-passed/25 text-shade-100' : 'bg-status-failed/30 text-shade-100';
  return (
    <>
      {diffChars(text, against).map((part, index) =>
        part.changed ? (
          <mark key={index} className={`rounded-[1px] ${mark}`}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Longest stretch a diff compares character by character; past it, the whole middle is marked. */
const MAX_DIFF_CHARS = 300;

/**
 * `text` split into runs that `other` shares (in order) and runs it does
 * not: the common start and end are cut off, and the middle is compared by
 * longest common subsequence.
 */
function diffChars(text: string, other: string): Array<{ text: string; changed: boolean }> {
  // By code point, so an emoji is one character and never splits into halves.
  const chars = [...text];
  const otherChars = [...other];
  let start = 0;
  while (start < chars.length && start < otherChars.length && chars[start] === otherChars[start]) start++;
  let end = 0;
  while (end < chars.length - start && end < otherChars.length - start && chars[chars.length - 1 - end] === otherChars[otherChars.length - 1 - end]) end++;
  const middle = chars.slice(start, chars.length - end);
  const otherMiddle = otherChars.slice(start, otherChars.length - end);
  const common = middle.length <= MAX_DIFF_CHARS && otherMiddle.length <= MAX_DIFF_CHARS ? commonChars(middle, otherMiddle) : new Set<number>();
  // Two unrelated words share a stray letter or two; marking around them reads as noise, so mark the whole middle.
  const kept = common.size * 3 >= middle.length ? common : new Set<number>();
  const parts: Array<{ text: string; changed: boolean }> = [];
  const push = (char: string, changed: boolean) => {
    const last = parts.at(-1);
    if (last?.changed === changed) parts.push({ text: `${parts.pop()?.text ?? ''}${char}`, changed });
    else parts.push({ text: char, changed });
  };
  for (const char of chars.slice(0, start)) push(char, false);
  middle.forEach((char, index) => push(char, !kept.has(index)));
  for (const char of chars.slice(chars.length - end)) push(char, false);
  return parts;
}

/** The indexes of `a` in a longest common subsequence of `a` and `b`. */
function commonChars(a: readonly string[], b: readonly string[]): Set<number> {
  const lengths = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const kept = new Set<number>();
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      kept.add(i);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  return kept;
}

/** Whether the report holds the line a source points at, so a frame has something to show. */
export function hasFrame(source: Source | undefined, model: ReportModel): source is Source {
  return source !== undefined && model.sources[source.file]?.[String(source.line)] !== undefined;
}

/**
 * The test code around a source location: line numbers, the line marked, and
 * a caret under the column. The marker is red only where the code `failed`;
 * a passed step's frame just points.
 */
export function CodeFrame({ source, model, failed = false }: { source: Source; model: ReportModel; failed?: boolean }) {
  const pointer = failed ? 'text-status-failed' : 'text-shade-300';
  const lines = model.sources[source.file];
  if (lines === undefined || lines[String(source.line)] === undefined) return null;
  const numbers = Object.keys(lines)
    .map(Number)
    .filter((line) => Math.abs(line - source.line) <= 2)
    .toSorted((a, b) => a - b);
  const width = String(numbers.at(-1) ?? source.line).length;
  return (
    <figure aria-label={`${source.file}:${source.line}`} className="flex flex-col gap-e2e-half">
      <pre className="type-code-s overflow-x-auto bg-shade-900 px-e2e-2 py-e2e-1 [font-variant-ligatures:none]">
        {numbers.map((line) => {
          const at = line === source.line;
          const code = lines[String(line)] ?? '';
          const gutter = `${at ? '>' : ' '} ${String(line).padStart(width)} | `;
          return (
            <span key={line} className={`block ${at ? 'text-shade-100' : 'text-shade-500'}`}>
              <span className={at ? pointer : 'text-shade-600'}>{gutter}</span>
              {code}
              {at ? (
                // The caret sits under the column by laying out the same text, invisible: tabs and wide glyphs line up too.
                <span aria-hidden className={`block ${pointer}`}>
                  <span className="invisible">{gutter}{code.slice(0, Math.max(0, source.column - 1))}</span>^
                </span>
              ) : null}
            </span>
          );
        })}
      </pre>
      <figcaption className="type-caption normal-case text-shade-500">
        {source.file}:{source.line}:{source.column}
      </figcaption>
    </figure>
  );
}

/** Copies the failure as a prompt for a coding agent: the error, the steps, and the files to read. */
function CopyPrompt({ prompt }: { prompt: () => string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="e2e-action ml-auto"
      title="Copy the failure, its steps, and the files to read, as a prompt for a coding agent"
      onClick={() => {
        copyText(prompt()).then(
          () => setState('copied'),
          () => setState('failed'),
        );
      }}
    >
      {state === 'copied' ? 'copied' : state === 'failed' ? 'copy failed' : 'copy prompt'}
    </button>
  );
}

/**
 * Puts text on the clipboard. A page served over plain http has no
 * clipboard API, and a browser can refuse it on `file://`; the selection
 * copy still works in both.
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.className = 'fixed opacity-0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('the browser refused to copy');
  }
}
