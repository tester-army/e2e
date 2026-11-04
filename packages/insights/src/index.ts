/**
 * `@e2e-dev/insights` public surface. The `insights()` reporter appends each
 * run to a history file; `analyze()` scores that history for flaky and broken
 * tests, replay cache misses, model cost, and duration; `quarantineFilter()`
 * leaves flaky tests out of a run by it; the `e2e-insights` bin renders it as
 * text, Markdown, HTML, or JSON.
 */

export { insights } from './reporter.ts';
export type { InsightsOptions } from './reporter.ts';
export { quarantineFilter } from './filter.ts';
export type { QuarantineOptions } from './filter.ts';
export { analyze } from './analyze.ts';
export type { AnalyzeOptions, Insights, Outcome, TestInsight, Verdict } from './analyze.ts';
export { digestReport } from './digest.ts';
export type { CacheCounts, HistoryRun, HistoryTest } from './digest.ts';
export { loadHistory } from './store.ts';
export type { LoadedHistory } from './store.ts';
export { renderHtml } from './render/html.ts';
export { renderMarkdown } from './render/markdown.ts';
export { renderText } from './render/text.ts';
