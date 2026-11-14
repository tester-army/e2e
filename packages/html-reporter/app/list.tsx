import { useMemo, useState } from 'react';
import {
  STATUS_FILTERS,
  byStatus,
  formatCost,
  formatDuration,
  formatTokens,
  matchesSearch,
  onTarget,
  repeatSuffix,
  type ReportModel,
  type Result,
  type StatusFilter,
} from './data.ts';
import { replaceRoute, routeHref } from './route.ts';
import { Icon, StatusIcon, StatusTag, Tag } from './ui.tsx';

/** The run page: what ran, the target and status tabs, the search box, and the tests as a tree of files and describe blocks. */
export function ListView({ model, status, search, target }: { model: ReportModel; status: StatusFilter; search: string; target: string | undefined }) {
  const counts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(STATUS_FILTERS).map(([name, matches]) => [
          name,
          onTarget(model.results, target).filter((result) => matches(result.status)).length,
        ]),
      ) as Record<StatusFilter, number>,
    [model, target],
  );
  const files = useMemo(() => {
    const shown = onTarget(model.results, target).filter((result) => STATUS_FILTERS[status](result.status) && matchesSearch(result, search));
    return [...Map.groupBy(shown, (result) => result.file)].map(([file, results]) => suiteTree(file, results)).toSorted((a, b) => byStatus(a.worst, b.worst));
  }, [model, status, search, target]);
  const params = { status: status === 'all' ? undefined : status, q: search, target };
  /** The targets the results ran on, each with how many of them it carries. */
  const targets = model.run.targets
    .filter((runTarget) => model.targetIds.has(runTarget.id))
    .map((runTarget) => ({ id: runTarget.id, count: model.results.filter((result) => result.targetId === runTarget.id).length }));

  return (
    <div className="flex flex-col gap-e2e-4">
      <RunHeader model={model} counts={counts} target={target} />
      <div className="flex flex-wrap items-center gap-x-e2e-4 gap-y-e2e-2 border-b border-shade-700 pb-e2e-2">
        {targets.length > 1 ? (
          <nav aria-label="Target" className="flex flex-wrap gap-x-e2e-4 gap-y-e2e-2">
            {[{ id: undefined as string | undefined, count: model.results.length }, ...targets].map(({ id, count }) => (
              <a
                key={id ?? 'all-targets'}
                href={routeHref({ ...params, target: id })}
                aria-current={id === target ? 'page' : undefined}
                className="e2e-action group flex items-baseline gap-e2e-1"
              >
                <span>{id ?? 'all targets'}</span>
                <span className="text-shade-500 group-aria-[current=page]:text-shade-100">{count}</span>
              </a>
            ))}
          </nav>
        ) : null}
        <nav aria-label="Status" className="flex flex-wrap gap-x-e2e-4 gap-y-e2e-2">
          {(Object.keys(STATUS_FILTERS) as StatusFilter[]).map((name) =>
            name !== 'all' && counts[name] === 0 ? null : (
              <a key={name} href={routeHref({ ...params, status: name === 'all' ? undefined : name })} aria-current={name === status ? 'page' : undefined} className="e2e-action group flex items-baseline gap-e2e-1">
                <span>{name}</span>
                <span className="text-shade-500 group-aria-[current=page]:text-shade-100">{counts[name]}</span>
              </a>
            ),
          )}
        </nav>
        <label className="relative ml-auto flex w-full items-center sm:w-80">
          <span className="pointer-events-none absolute left-e2e-2 text-shade-500">
            <Icon name="search" />
          </span>
          <input
            type="search"
            className="e2e-search pl-e2e-6"
            placeholder="search tests, files, tags"
            aria-label="Search tests"
            value={search}
            onChange={(event) => replaceRoute({ ...params, q: event.target.value })}
          />
        </label>
      </div>
      {files.length === 0 ? (
        <p role="status" className="type-caption py-e2e-6 text-center text-shade-500">
          no tests match these filters.
        </p>
      ) : (
        files.map((file) => <FileGroup key={file.title} file={file} model={model} />)
      )}
    </div>
  );
}

/** `counts` are the listed tests', so the headline matches the tabs: filtered-out tests count as skipped there. */
function RunHeader({ model, counts, target }: { model: ReportModel; counts: Record<StatusFilter, number>; target: string | undefined }) {
  const { run } = model;
  const { usage } = run;
  const duration = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  const scope = run.targets
    .filter((runTarget) => model.targetIds.has(runTarget.id) && (target === undefined || runTarget.id === target))
    .map((runTarget) => `${runTarget.id} (${runTarget.engine.name})`)
    .join(', ');
  const runFacts = [
    new Date(run.startedAt).toLocaleString(),
    formatDuration(duration),
    usage.modelTokens > 0 ? `${formatTokens(usage.modelTokens)} tokens` : undefined,
    usage.estimatedCostUsd === undefined ? undefined : formatCost(usage.estimatedCostUsd),
    `e2e ${run.runner.version}`,
  ];
  // One target picked: its fact leads and the run-wide ones follow a label, so none of them reads as the target's own.
  const facts = (target === undefined ? [runFacts[0], runFacts[1], scope, ...runFacts.slice(2)] : [scope, 'run totals:', ...runFacts]).filter(
    (fact) => fact !== undefined && fact !== '',
  );
  // The bar's segments, best first; each grows with its count.
  const segments = [
    { label: 'passed', value: counts.passed, color: 'bg-status-passed' },
    { label: 'flaky', value: counts.flaky, color: 'bg-status-flaky' },
    { label: 'failed', value: counts.failed, color: 'bg-status-failed' },
    { label: 'interrupted', value: counts.interrupted, color: 'bg-status-interrupted' },
    { label: 'skipped', value: counts.skipped, color: 'bg-status-skipped' },
  ].filter((segment) => segment.value > 0);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <header className="flex flex-col gap-e2e-3">
      <div className="flex items-end justify-between gap-e2e-3">
        <h1 className="type-h3 lowercase">{target === undefined ? `tests ${run.status === 'error' ? 'errored' : run.status}` : `tests on ${target}`}</h1>
        <p className="flex shrink-0 flex-col items-end gap-e2e-half">
          <span className="type-caption text-shade-500">passed</span>
          <span className="type-number-l">
            {counts.passed}/{total}
          </span>
        </p>
      </div>
      {total === 0 ? null : (
        <div role="img" aria-label={segments.map((segment) => `${segment.value} ${segment.label}`).join(', ')} className="flex h-e2e-1 gap-[2px]">
          {segments.map((segment) => (
            <div key={segment.label} title={`${segment.value} ${segment.label}`} className={`basis-0 ${segment.color}`} style={{ flexGrow: segment.value }} />
          ))}
        </div>
      )}
      <p className="type-caption flex flex-wrap gap-x-e2e-2 gap-y-e2e-half text-shade-400">
        {facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </p>
      {run.errors.map((error) => (
        <p key={`${error.code}:${error.message}`} className="type-code-s border-l-2 border-status-failed bg-shade-800 px-e2e-2 py-e2e-1 whitespace-pre-wrap text-shade-200">
          <span className="text-status-failed">{error.code}</span> {error.message}
        </p>
      ))}
    </header>
  );
}

/** A test file or a describe block: its own tests, then its nested blocks, each list worst status first. */
interface Suite {
  readonly title: string;
  readonly tests: readonly Result[];
  readonly suites: readonly Suite[];
  /** The result with the worst status anywhere under it, which orders it among its siblings. */
  readonly worst: Result;
}

/** Groups `results` (none empty) by their describe titles from `depth` on, the way `tree` nests directories. */
function suiteTree(title: string, results: readonly Result[], depth = 0): Suite {
  const tests = results.filter((result) => result.titlePath.length - 1 <= depth).toSorted(byStatus);
  const nested = Map.groupBy(
    results.filter((result) => result.titlePath.length - 1 > depth),
    (result) => result.titlePath[depth]!,
  );
  const suites = [...nested].map(([name, inner]) => suiteTree(name, inner, depth + 1)).toSorted((a, b) => byStatus(a.worst, b.worst));
  return { title, tests, suites, worst: results.toSorted(byStatus)[0]! };
}

/** One test file as a tree: nesting shows as indentation, not lines. Its path folds the file's tests away. */
function FileGroup({ file, model }: { file: Suite; model: ReportModel }) {
  const [open, setOpen] = useState(true);
  return (
    <section aria-label={file.title} className="flex flex-col">
      <h2 className="pb-e2e-1">
        <button
          type="button"
          className="type-caption flex cursor-pointer items-center gap-e2e-half normal-case text-shade-400"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? 'disclosure-open' : 'disclosure-closed'} />
          {file.title}
        </button>
      </h2>
      {open ? <SuiteItems suite={file} model={model} /> : null}
    </section>
  );
}

/** A suite's tests and nested blocks, indented under its title. */
function SuiteItems({ suite, model }: { suite: Suite; model: ReportModel }) {
  // A tag every test here carries names the group, not a test: the rows leave it out.
  const [first, ...rest] = suite.tests;
  const shared = rest.length === 0 ? [] : (first?.tags ?? []).filter((tag) => rest.every((result) => result.tags.includes(tag)));
  return (
    <ul className="flex flex-col pl-e2e-2 sm:pl-e2e-3">
      {suite.tests.map((result) => (
        <li key={result.id}>
          <TestRow result={result} model={model} tags={result.tags.filter((tag) => !shared.includes(tag))} />
        </li>
      ))}
      {suite.suites.map((child) => (
        <li key={child.title}>
          <span className="type-body-s block px-e2e-1 py-e2e-1 text-shade-400">{child.title}</span>
          <SuiteItems suite={child} model={model} />
        </li>
      ))}
    </ul>
  );
}

/** One test's line; `tags` are the ones worth showing on it. */
function TestRow({ result, model, tags }: { result: Result; model: ReportModel; tags: readonly string[] }) {
  const attempts = model.attempts(result);
  const final = attempts.at(-1);
  const retries = attempts.length - 1;
  const showTarget = model.targetIds.size > 1;
  // Passed and failed say themselves by icon; any other status gets a tag too.
  const tagged = result.status !== 'passed' && result.status !== 'failed';
  return (
    <a
      href={routeHref({ test: result.id })}
      className="group flex items-center gap-e2e-2 px-e2e-1 py-e2e-1 hover:bg-shade-800 focus-visible:bg-shade-800"
    >
      <StatusIcon status={result.status} named={!tagged} />
      <span className="min-w-0 flex-1">
        <span className="type-body-s block truncate text-shade-100">{result.titlePath.at(-1)}
          {repeatSuffix(result)}
        </span>
        {final?.error === undefined ? null : <span className="type-code-s block truncate text-shade-500">{final.error.message.split('\n')[0]}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-e2e-1">
        {/* A phone keeps the width for the title; the test's page still shows its tags and target. */}
        <span className="hidden items-center gap-e2e-1 sm:flex">
          {tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          {showTarget ? <Tag>{result.targetId}</Tag> : null}
        </span>
        {tagged ? <StatusTag status={result.status} /> : null}
        {retries > 0 ? (
          <Tag tone="flaky" hint="Ran again after a failed attempt; the last attempt decides the result.">
            {retries === 1 ? '1 retry' : `${retries} retries`}
          </Tag>
        ) : null}
        <span className="type-caption w-16 text-right text-shade-500">{final === undefined ? '' : formatDuration(final.durationMs)}</span>
        <span className="text-shade-600">
          <Icon name="chevron-right" />
        </span>
      </span>
    </a>
  );
}
