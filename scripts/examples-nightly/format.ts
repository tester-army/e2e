/**
 * The Slack message for one nightly run of the examples
 * (`.github/workflows/examples.yml`): a headline, then one line per example
 * and platform saying how far it got and what its report counted.
 */

/** The step outcomes GitHub reports (`steps.<id>.outcome`); empty for a step the job does not have. */
export type StepOutcome = 'success' | 'failure' | 'cancelled' | 'skipped' | '';

/** What one matrix job of the examples workflow writes to `outcome.json`. */
export interface Outcome {
  /** The matrix id, e.g. `flutter`. */
  id: string;
  /** The example's display name, e.g. `Flutter`. */
  name: string;
  platform: 'web' | 'android' | 'ios';
  /** The job's name, as GitHub lists it, to link the line to its log. */
  job: string;
  setup: StepOutcome;
  build: StepOutcome;
  test: StepOutcome;
}

/** The counts the run's `report.json` (`report-1`) carries in `run.summary`, plus its duration. */
export interface ReportCounts {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  interrupted: number;
  durationMs?: number;
}

/**
 * The second pass `run-tests.sh` gave the suite after an infrastructure
 * failure: the tests the first pass did not pass, or the whole suite when it
 * wrote no report.
 */
export type SecondPass = 'last-failed' | 'full';

export interface Row {
  outcome: Outcome;
  /** The last pass's report: after a `last-failed` second pass, it counts only the tests that pass ran. */
  report?: ReportCounts;
  secondPass?: SecondPass;
  /** The job's log, when the API listed it. */
  jobUrl?: string;
}

export interface RunInfo {
  runUrl: string;
  sha: string;
  /** Why no example ran: the model key is missing, or the packages did not build from main. */
  blocked?: 'credential' | 'pack';
  /** Jobs that ended without writing an outcome (a runner lost mid-job). */
  missing?: string[];
  /** Set when the run's jobs could not be listed, so `missing` may be incomplete. */
  jobsUnknown?: boolean;
}

type Verdict = 'passed' | 'flaky' | 'failed' | 'cancelled';

const ICON: Record<Verdict, string> = { passed: '✅', flaky: '🟡', failed: '❌', cancelled: '⏹️' };
const PLATFORM_ORDER = ['web', 'android', 'ios'] as const;
const PLATFORM_LABEL: Record<Outcome['platform'], string> = { web: 'web', android: 'Android', ios: 'iOS' };
const SECOND_PASS: Record<SecondPass, string> = {
  'last-failed': 'infrastructure failure, then the tests it stopped once more: ',
  full: 'infrastructure failure before any report, then the suite once more: ',
};

/** Escapes the three characters Slack's mrkdwn treats as markup. */
function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** `1m 05s`, or `42s` under a minute. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

/** The counts worth showing, biggest news first. */
function counts(report: ReportCounts): string {
  const parts = [
    report.failed > 0 ? `${report.failed} failed` : '',
    report.interrupted > 0 ? `${report.interrupted} interrupted` : '',
    report.flaky > 0 ? `${report.flaky} flaky` : '',
    `${report.passed} passed`,
    report.skipped > 0 ? `${report.skipped} skipped` : '',
  ];
  return parts.filter((part) => part !== '').join(', ');
}

/** How one example did, and the words for it. */
function judge(row: Row): { verdict: Verdict; detail: string } {
  const { outcome, report } = row;
  const stages = [outcome.setup, outcome.build, outcome.test];
  if (stages.includes('cancelled')) return { verdict: 'cancelled', detail: 'cancelled' };
  if (outcome.setup === 'failure') return { verdict: 'failed', detail: 'setup failed' };
  if (outcome.build === 'failure') return { verdict: 'failed', detail: 'app build failed' };
  if (report === undefined) {
    return { verdict: 'failed', detail: outcome.test === 'success' ? 'no report' : 'failed before the tests ran' };
  }
  const time = report.durationMs === undefined ? '' : ` (${duration(report.durationMs)})`;
  const pass = row.secondPass === undefined ? '' : SECOND_PASS[row.secondPass];
  if (outcome.test !== 'success' || report.failed > 0 || report.interrupted > 0) {
    return { verdict: 'failed', detail: `${pass}${counts(report)}${time}` };
  }
  if (report.passed === 0) return { verdict: 'failed', detail: `${pass}no test passed: ${counts(report)}` };
  const verdict = report.flaky > 0 || row.secondPass !== undefined ? 'flaky' : 'passed';
  return { verdict, detail: `${pass}${counts(report)}${time}` };
}

/** The whole message, as Slack mrkdwn. */
export function formatMessage(rows: readonly Row[], run: RunInfo): string {
  const link = `<${run.runUrl}|run>`;
  const commit = `\`main@${escape(run.sha.slice(0, 7))}\``;
  if (run.blocked === 'credential') {
    return `❌ *Nightly examples*: the AI_GATEWAY_API_KEY secret is missing, so no example ran. ${link}`;
  }
  if (run.blocked === 'pack') {
    return `❌ *Nightly examples*: building the packages from ${commit} failed, so no example ran. ${link}`;
  }

  const sorted = rows.toSorted(
    (a, b) =>
      PLATFORM_ORDER.indexOf(a.outcome.platform) - PLATFORM_ORDER.indexOf(b.outcome.platform) ||
      a.outcome.name.localeCompare(b.outcome.name),
  );
  const judged = sorted.map((row) => ({ row, ...judge(row) }));
  const failed = judged.filter((entry) => entry.verdict === 'failed' || entry.verdict === 'cancelled').length;
  const flaky = judged.filter((entry) => entry.verdict === 'flaky').length;
  const missing = run.missing ?? [];
  const total = judged.length + missing.length;
  const bad = failed + missing.length;
  if (total === 0) {
    return `❌ *Nightly examples*: no example reported a result on ${commit}. ${link}`;
  }

  const headline =
    bad > 0
      ? `❌ *Nightly examples*: ${bad} of ${total} failed`
      : `${flaky > 0 ? '🟡' : '✅'} *Nightly examples*: all ${total} passed${flaky > 0 ? `, ${flaky} flaky` : ''}`;
  const lines = judged.map(({ row, verdict, detail }) => {
    const label = `*${escape(row.outcome.name)}* · ${PLATFORM_LABEL[row.outcome.platform]}`;
    const log = verdict !== 'passed' && row.jobUrl !== undefined ? ` <${row.jobUrl}|log>` : '';
    return `${ICON[verdict]} ${label}: ${escape(detail)}${log}`;
  });
  for (const job of missing) lines.push(`❌ *${escape(job)}*: the job ended without a result`);
  if (run.jobsUnknown) lines.push('⚠️ Could not list the run\'s jobs, so a job that ended without a result is not shown.');
  return [`${headline} on ${commit}. ${link}`, '', ...lines].join('\n');
}
