import { StrictMode, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { buildModel, isStatusFilter, readPayload, type ReportModel } from './data.ts';
import { ListView } from './list.tsx';
import { useRoute } from './route.ts';
import { TestView } from './test.tsx';
import { ThemeSwitch } from './theme.tsx';
import { Logo } from './ui.tsx';
import './styles.css';

/** Routes the hash to the run page or one test's page. */
function App({ model }: { model: ReportModel }) {
  const route = useRoute();
  const testId = route.get('test');
  const result = useMemo(() => (testId === null ? undefined : model.results.find((candidate) => candidate.id === testId)), [model, testId]);
  const status = route.get('status');
  return result === undefined ? (
    <ListView model={model} status={isStatusFilter(status) ? status : 'all'} search={route.get('q') ?? ''} />
  ) : (
    <TestView model={model} result={result} attemptParam={route.get('attempt')} />
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[90rem] flex-col gap-e2e-4 px-e2e-3 py-e2e-4">
      <header className="flex items-center justify-between gap-e2e-2">
        <a href="#" className="w-fit text-shade-100" aria-label="All tests">
          <Logo className="h-e2e-3" />
        </a>
        <ThemeSwitch />
      </header>
      {children}
    </div>
  );
}

const payload = readPayload();
const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Shell>
        {payload === undefined ? (
          <p className="type-caption text-shade-500">this page holds no report. the e2e html reporter fills it at the end of a run.</p>
        ) : (
          <App model={buildModel(payload)} />
        )}
      </Shell>
    </StrictMode>,
  );
}
