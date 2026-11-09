/**
 * The design system pieces the page uses, copied from e2e-site's
 * apps/design-system (`Logo`, `Tag`), and its icons, which are Lucide's.
 */

import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Maximize,
  Minus,
  Monitor,
  Moon,
  Pause,
  Play,
  Search,
  Sun,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ResultStatus, Step } from './data.ts';

const ICONS = {
  check: Check,
  close: X,
  'triangle-alert': TriangleAlert,
  minus: Minus,
  'chevron-right': ChevronRight,
  'disclosure-closed': ChevronRight,
  'disclosure-open': ChevronDown,
  'arrow-left': ArrowLeft,
  play: Play,
  pause: Pause,
  expand: Maximize,
  search: Search,
  system: Monitor,
  light: Sun,
  dark: Moon,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** A Lucide icon at 16px in `currentColor`. Decorative unless `label` names it. */
export function Icon({ name, label }: { name: IconName; label?: string }) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={16}
      strokeWidth={2}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className="shrink-0"
    />
  );
}

const LOGOTYPE = [
  [155.91, 0, 90.24, 19.06], [26.94, 24.48, 82.4, 19.09], [145.32, 24.48, 35.83, 19.09], [220.91, 24.48, 35.84, 19.09],
  [297.82, 24.48, 82.43, 19.09], [10.59, 49.04, 32.69, 19.05], [92.79, 49.04, 33.14, 19.05], [210.32, 49.04, 35.83, 19.05],
  [281.46, 49.04, 32.69, 19.05], [363.66, 49.04, 33.18, 19.05], [0, 73.54, 135.96, 19.08], [185.09, 73.54, 35.8, 19.08],
  [270.88, 73.54, 135.97, 19.08], [4.13, 98.07, 32.68, 19.05], [158.07, 98.04, 35.83, 19.08], [274.98, 98.07, 32.68, 19.05],
  [26.94, 122.57, 82.4, 19.05], [145.32, 122.57, 113.33, 19.05], [297.82, 122.57, 82.43, 19.05],
] as const;

/** The e2e logotype, filled with `currentColor`; size it by width or height. */
export function Logo({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 407 142" fill="currentColor" className={className} role="img" aria-label="e2e">
      {LOGOTYPE.map(([x, y, width, height]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={width} height={height} />
      ))}
    </svg>
  );
}

type Tone = 'passed' | 'failed' | 'flaky' | 'skipped' | 'interrupted';

const TONE_TEXT: Record<Tone, string> = {
  passed: 'text-status-passed',
  failed: 'text-status-failed',
  flaky: 'text-status-flaky',
  skipped: 'text-status-skipped',
  interrupted: 'text-status-interrupted',
};

const TONE_ICON: Record<Tone, IconName> = { passed: 'check', failed: 'close', flaky: 'triangle-alert', skipped: 'minus', interrupted: 'minus' };

function resultTone(status: ResultStatus): Tone {
  return status === 'timed-out' ? 'failed' : status;
}

const STEP_TONE: Record<Step['status'], Tone> = { passed: 'passed', failed: 'failed', blocked: 'failed', 'timed-out': 'failed', cancelled: 'skipped' };

/** A result or attempt status as a colored icon, named for screen readers unless a `StatusTag` beside it already says it. */
export function StatusIcon({ status, named = true }: { status: ResultStatus; named?: boolean }) {
  const tone = resultTone(status);
  return (
    <span className={TONE_TEXT[tone]}>
      <Icon name={TONE_ICON[tone]} {...(named ? { label: status } : {})} />
    </span>
  );
}

export function StepStatusIcon({ status }: { status: Step['status'] }) {
  const tone = STEP_TONE[status];
  return (
    <span className={TONE_TEXT[tone]}>
      <Icon name={TONE_ICON[tone]} label={status} />
    </span>
  );
}

/** Which edge of its tag a hint lines up with; tags near the right of the page use `end` so the hint stays on screen. */
type HintAlign = 'start' | 'end';

/**
 * The design system's tag: a caption-size chip. `tone` tints it with a status
 * color; `hint` explains it in a tooltip on hover, and to screen readers.
 */
export function Tag({
  children,
  tone,
  hint,
  align = 'end',
}: {
  children: ReactNode;
  tone?: Tone | 'mint' | undefined;
  hint?: string | undefined;
  align?: HintAlign;
}) {
  const color =
    tone === undefined ? 'bg-shade-700 text-shade-300' : tone === 'mint' ? 'bg-mint/15 text-mint' : `bg-current/15 ${TONE_TEXT[tone]}`;
  if (hint === undefined) return <span className={`e2e-tag ${color}`}>{children}</span>;
  return (
    <span className={`e2e-tag group/tag relative cursor-help ${color}`} aria-description={hint}>
      {children}
      <span
        aria-hidden
        className={`e2e-panel type-body-s pointer-events-none invisible absolute bottom-full z-10 mb-e2e-1 w-max max-w-72 px-e2e-1 py-e2e-half text-xs whitespace-normal normal-case text-shade-200 group-hover/tag:visible ${align === 'end' ? 'right-0' : 'left-0'}`}
      >
        {hint}
      </span>
    </span>
  );
}

/** What a status means, for the ones whose name alone does not say. */
const STATUS_HINT: Partial<Record<ResultStatus, string>> = {
  flaky: 'Failed at first, then passed on a retry.',
  'timed-out': 'Ran past its time limit and was stopped.',
  interrupted: 'The run stopped before this test finished.',
  skipped: 'Did not run: skipped in the test file, or left out by a filter.',
};

export function StatusTag({ status, align }: { status: ResultStatus; align?: HintAlign }) {
  return (
    <Tag tone={resultTone(status)} hint={STATUS_HINT[status]} {...(align === undefined ? {} : { align })}>
      {status}
    </Tag>
  );
}
