/**
 * The focuses of an exploration's explorers: every explorer gets the whole
 * goal and one focus, a kind of defect to hunt, so several explorers spread
 * over different kinds of defects rather than over different areas of the
 * app. Explorer i takes the i-th focus. The built-in list is ordered by how
 * many defects each kind tends to yield and worded for any app; the
 * environment focus follows the target's platform. Users may bring their own.
 */

import { ConfigurationError } from '../internal/errors.ts';
import { PARALLEL_BOUNDS } from './bounds.ts';

/** One explorer's focus: a label for the reporters and the record, and the text the planner and the explorer read. */
export interface ExploreFocus {
  readonly label: string;
  readonly text: string;
}

/** The platforms whose environment focus has its own wording; any other platform gets the generic one. */
type FocusPlatform = 'web' | 'mobile' | 'other';

/** A user focus at most, in characters. */
const MAX_FOCUS_CHARS = 1_000;
/** A label derived from a user focus stops at its first clause or here. */
const MAX_LABEL_CHARS = 40;

const RESULTS: ExploreFocus = {
  label: 'wrong results',
  text: 'wrong results: carry out the main actions the goal names end to end and check what the app shows and keeps afterwards (values, totals, counts, dates, statuses, and messages), on this screen and on every other screen that shows the same data; act on an item that is not the first and check that the right one changed.',
};

const INPUT: ExploreFocus = {
  label: 'input and validation',
  text: 'input and validation: give every input the app takes edge cases (empty, whitespace-only, very long, duplicate, accented, emoji, and special characters such as %, _, quotes, and <tags>; zero, negative, huge, and boundary numbers and dates; the wrong kind of value) and check what is accepted, what is rejected with a clear message, and what a rejected entry keeps or loses.',
};

const STATE: ExploreFocus = {
  label: 'state and navigation',
  text: 'state and navigation: combine controls (filters, sorting, search, paging, tabs, settings) and check earlier choices are kept; go back, reload or relaunch, and check what survives and what should not; change or remove something other screens depend on, then revisit them.',
};

const ENVIRONMENT: Record<FocusPlatform, string> = {
  web: 'check the main screens at tablet and phone widths (resize the viewport with resize_viewport when it is offered) and with long text, for overlap, clipping, and controls that become unreachable; check browser back and forward, and that every control has a name a screen reader can announce.',
  mobile: 'rotate the device where the app allows it; send the app to the background and resume it; check that the keyboard never covers the field being filled; answer permission prompts both ways; open links that lead deep into the app; check long text for overlap and clipping, and that every control has a name a screen reader can announce.',
  other: 'check the main screens at the sizes the app supports and with long text, for overlap, clipping, and controls that become unreachable, and that every control has a name a screen reader can announce.',
};

const ERRORS: ExploreFocus = {
  label: 'errors and recovery',
  text: 'errors and recovery: reach empty, loading, and error states (nothing to show, a missing item, a request that fails or is slow where you can cause it, a session that ended), submit twice quickly, and check every state explains itself and lets the user recover; then use the controls the main flows skip: menus, shortcuts, settings, sharing, uploads, and downloads.',
};

/** The platform whose environment wording fits `platform`, the target's platform label. */
function focusPlatform(platform: string): FocusPlatform {
  if (platform === 'web') return 'web';
  if (platform === 'ios' || platform === 'android') return 'mobile';
  return 'other';
}

/**
 * The built-in focuses of `count` explorers, in order. The environment focus
 * follows the target's platform, and looks at another account's view too,
 * but only when another account is there to sign in with: more than one
 * configured and no saved session pinning the run to one.
 */
export function exploreFocuses(count: number, options: { readonly platform: string; readonly otherAccount: boolean }): readonly ExploreFocus[] {
  const checks = ENVIRONMENT[focusPlatform(options.platform)];
  const environment: ExploreFocus = options.otherAccount
    ? {
        label: 'layout and roles',
        text: `layout, environment, and roles: ${checks} Then sign in as another of the configured accounts and check what each role can see and do.`,
      }
    : { label: 'layout and environment', text: `layout and environment: ${checks}` };
  return [RESULTS, INPUT, STATE, environment, ERRORS].slice(0, count);
}

/**
 * The user's own focuses (`--focus`), in order, each labeled by its first
 * clause, shortened. Empty or overlong text, or more focuses than one run
 * may have explorers, is `INVALID_CONFIG`.
 */
function userFocuses(texts: readonly string[]): readonly ExploreFocus[] {
  if (texts.length > PARALLEL_BOUNDS.max) {
    throw new ConfigurationError('INVALID_CONFIG', `at most ${String(PARALLEL_BOUNDS.max)} focuses, one per explorer, got ${String(texts.length)}`);
  }
  return texts.map((raw) => {
    const text = raw.trim();
    if (text === '') throw new ConfigurationError('INVALID_CONFIG', 'a focus must not be empty');
    if (text.length > MAX_FOCUS_CHARS) {
      throw new ConfigurationError('INVALID_CONFIG', `a focus must be at most ${String(MAX_FOCUS_CHARS)} characters, got ${String(text.length)}`);
    }
    return { label: focusLabel(text), text };
  });
}

/** A focus's first clause as its label, shortened to `MAX_LABEL_CHARS`. */
function focusLabel(text: string): string {
  const clause = text.split(/[.:;\n]/, 1)[0]!.trim();
  const short = clause === '' ? text : clause;
  return short.length <= MAX_LABEL_CHARS ? short : `${short.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`;
}

/**
 * The focuses an exploration runs, one per explorer. User focuses replace the
 * built-in list and set the explorer count; `parallel`, when also given, must
 * match it. Without user focuses, `parallel` explorers take the first
 * built-in focuses, and a single explorer takes none.
 */
export function chooseFocuses(options: {
  readonly focuses: readonly string[] | undefined;
  readonly parallel: number | undefined;
  readonly platform: string;
  readonly otherAccount: boolean;
}): readonly ExploreFocus[] {
  const { focuses, parallel } = options;
  if (focuses !== undefined && focuses.length > 0) {
    const chosen = userFocuses(focuses);
    if (parallel !== undefined && parallel !== chosen.length) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `parallel is ${String(parallel)} but ${String(chosen.length)} focus${chosen.length === 1 ? ' was' : 'es were'} given: each explorer takes one focus, so pass as many focuses as explorers, or leave parallel out`,
      );
    }
    return chosen;
  }
  const count = parallel ?? PARALLEL_BOUNDS.default;
  return count === 1 ? [] : exploreFocuses(count, options);
}

/** The `Focus:` line the planner and the explorer read beside the goal. */
export function focusContext(focus: ExploreFocus): string {
  return [
    `Focus: ${focus.text}`,
    'Other explorers may work toward the same goal at the same time with other focuses, so every step serves this one.',
    'They use the same app and the same accounts, so data and settings can change under you: work on items you create, and never report as a defect a change another explorer could have made.',
  ].join(' ');
}
