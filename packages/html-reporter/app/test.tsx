import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  artifactUrl,
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  testTitle,
  timedVideos,
  videoPosition,
  type Artifact,
  type AttemptView,
  type ReportModel,
  type Result,
  type Step,
  type TimedVideo,
} from './data.ts';
import { CodeFrame, ErrorBlock, hasFrame } from './failure.tsx';
import { failurePrompt } from './prompt.ts';
import { routeHref } from './route.ts';
import { isPortrait, VideoPlayer, type VideoShape } from './player.tsx';
import { Icon, StatusTag, StepStatusIcon, Tag } from './ui.tsx';

/** One test: its attempts as tabs, the error, the steps, and the video that plays along with them. */
export function TestView({ model, result, attemptParam }: { model: ReportModel; result: Result; attemptParam: string | null }) {
  const attempts = model.attempts(result);
  const chosen = attemptParam === null ? attempts.length - 1 : Number(attemptParam) - 1;
  const attempt = attempts[chosen] ?? attempts.at(-1);

  return (
    <article className="flex flex-col gap-e2e-4">
      <header className="flex flex-col gap-e2e-2">
        <a href="#" className="e2e-action flex items-center gap-e2e-1">
          <Icon name="arrow-left" /> all tests
        </a>
        <span className="type-caption normal-case text-shade-500">
          {result.source.file}:{result.source.line} · {result.targetId}
          {result.agent === 'default' ? '' : ` · agent ${result.agent}`}
        </span>
        <h1 className="type-h5">{testTitle(result)}</h1>
        <div className="flex flex-wrap items-center gap-e2e-1">
          <StatusTag status={result.status} align="start" />
          {result.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          {result.skip === undefined ? null : <span className="type-caption text-shade-400">skipped: {result.skip.reason}</span>}
        </div>
      </header>
      {attempts.length > 1 ? (
        <nav aria-label="Attempts" className="flex gap-e2e-3 border-b border-shade-700 pb-e2e-1">
          {attempts.map((candidate, index) => (
            <a
              key={candidate.index}
              href={routeHref({ test: result.id, attempt: String(index + 1) })}
              aria-current={candidate === attempt ? 'page' : undefined}
              className="e2e-action"
            >
              attempt {index + 1} · {candidate.status}
            </a>
          ))}
        </nav>
      ) : null}
      {attempt === undefined ? (
        <p className="type-caption text-shade-500">this test never ran an attempt.</p>
      ) : (
        <AttemptPanel
          platform={result.platform}
          key={`${result.id}:${attempt.index}`}
          attempt={attempt}
          model={model}
          prompt={() => failurePrompt(model, result, attempt, { number: attempts.indexOf(attempt) + 1, count: attempts.length })}
        />
      )}
    </article>
  );
}

/** The web engine's default viewport, and a phone's screen in points: what a recording most likely measures before it loads. */
const WEB_SHAPE: VideoShape = { width: 1280, height: 720 };
const PHONE_SHAPE: VideoShape = { width: 402, height: 874 };

function AttemptPanel({ attempt, model, prompt, platform }: { attempt: AttemptView; model: ReportModel; prompt: () => string; platform: string }) {
  const videos = useMemo(() => timedVideos(attempt.artifacts, model.media), [attempt, model.media]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoIndex, setVideoIndex] = useState(0);
  const [playhead, setPlayhead] = useState<number | undefined>(undefined);
  // A phone recording sits beside the steps instead of above them. Until the file loads, the
  // screen the failure recorded, else the platform's usual one, stands in for its size.
  const [shape, setShape] = useState<VideoShape>(
    () => attempt.failure?.viewport ?? (platform === 'ios' || platform === 'android' ? PHONE_SHAPE : WEB_SHAPE),
  );
  const portrait = isPortrait(shape);

  // The step the video is showing: the last one that started at or before the playhead.
  const playingStep = playhead === undefined ? undefined : attempt.steps.findLast((step) => Date.parse(step.startedAt) <= playhead);

  const seek = (step: Step) => {
    const position = videoPosition(step, videos);
    if (position === undefined) return;
    setVideoIndex(position.video);
    // A new segment loads its source first; seek once its metadata is in.
    requestAnimationFrame(() => {
      const element = videoRef.current;
      if (element === null) return;
      const go = () => {
        element.currentTime = position.seconds;
        void element.play();
      };
      if (element.readyState >= 1) go();
      else element.addEventListener('loadedmetadata', go, { once: true });
      element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };

  // The error points at the statement; the failed step at the call in it, where the caret belongs.
  const failedStep = attempt.steps.findLast((step) => step.status === 'failed');
  const thrownAt = attempt.error?.source;
  const failingCall =
    failedStep?.source !== undefined && thrownAt !== undefined && failedStep.source.file === thrownAt.file && failedStep.source.line === thrownAt.line
      ? failedStep.source
      : thrownAt;

  // The failure evidence has its own section; the gallery and the file list leave it out.
  const evidence = new Set([attempt.failure?.screenshot, attempt.failure?.screen]);
  // A page without media (`media: 'none'`), or a file the reporter could not embed, has no URL to show.
  const shown = attempt.artifacts.filter((artifact) => !evidence.has(artifact.id) && artifactUrl(artifact, model.media) !== undefined);
  const screenshots = shown.filter((artifact) => artifact.kind === 'screenshot');
  const files = shown.filter((artifact) => artifact.kind === 'download' || artifact.kind === 'log');

  return (
    <div className="flex min-w-0 flex-col gap-e2e-4">
      {attempt.error === undefined ? null : <ErrorBlock error={attempt.error} model={model} source={failingCall} prompt={prompt} />}
      {attempt.secondaryErrors.map((error) => (
        <ErrorBlock key={`${error.code}:${error.message}`} error={error} model={model} secondary />
      ))}
      <div className={portrait ? 'grid items-start gap-e2e-4 md:grid-cols-[22rem_minmax(0,1fr)]' : 'flex flex-col gap-e2e-4'}>
        {videos.length === 0 ? null : (
          <VideoPlayer
            videos={videos}
            index={videoIndex}
            onIndexChange={setVideoIndex}
            videoRef={videoRef}
            steps={attempt.steps}
            playingStep={playingStep}
            onPlayhead={setPlayhead}
            shape={shape}
            onShape={setShape}
          />
        )}
        <section aria-label="Steps" className="flex min-w-0 flex-col gap-e2e-1">
          <h2 className="type-caption text-shade-500">steps · {formatDuration(attempt.durationMs)}</h2>
          {attempt.steps.length === 0 ? (
            <p className="type-caption text-shade-500">no steps were recorded.</p>
          ) : (
            <ol className="flex flex-col border-t border-shade-800">
              {attempt.steps.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  attempt={attempt}
                  model={model}
                  videos={videos}
                  playing={step === playingStep}
                  onSeek={seek}
                />
              ))}
            </ol>
          )}
        </section>
      </div>
      {attempt.appLog.length === 0 ? null : (
        <section aria-label="App log" className="flex flex-col gap-e2e-1">
          <h2 className="type-caption text-shade-500">app log</h2>
          <pre className="type-code-s e2e-panel max-h-96 overflow-auto p-e2e-2 text-shade-300">
            {attempt.appLog.map((line) => `${line.level.padEnd(5)} ${line.text}`).join('\n')}
          </pre>
        </section>
      )}
      <div className="grid gap-e2e-4 md:grid-cols-2">
        <FailureEvidence attempt={attempt} model={model} />
        {screenshots.length === 0 ? null : (
          <section aria-label="Screenshots" className="flex flex-col gap-e2e-1">
            <h2 className="type-caption text-shade-500">screenshots</h2>
            <div className="grid grid-cols-2 gap-e2e-1">
              {screenshots.map((artifact) => (
                <Screenshot key={artifact.id} artifact={artifact} model={model} />
              ))}
            </div>
          </section>
        )}
        {files.length === 0 ? null : (
          <section aria-label="Files" className="flex flex-col gap-e2e-1">
            <h2 className="type-caption text-shade-500">files</h2>
            <ul className="flex flex-col gap-e2e-half">
              {files.map((artifact) => (
                <li key={artifact.id}>
                  <ArtifactLink artifact={artifact} model={model} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

type CacheMode = NonNullable<Step['cache']>['mode'];

const CACHE_LABEL: Record<CacheMode, string> = {
  'self-finalized': 'replayed',
  'agent-concluded': 'partly replayed',
  missed: 'live',
};

const CACHE_HINT: Record<CacheMode, string> = {
  'self-finalized': 'Replayed the actions recorded in an earlier run, with no model call.',
  'agent-concluded': 'Replayed the recorded actions, then the agent called the model to finish the step.',
  missed: 'No recording this step could use, so the agent ran it with the model.',
};

const PHASE_HINT: Record<NonNullable<Step['phase']>, string> = {
  beforeEach: 'Ran in a beforeEach hook, before the test body.',
  afterEach: 'Ran in an afterEach hook, after the test body.',
};

function StepRow({
  step,
  attempt,
  model,
  videos,
  playing,
  onSeek,
}: {
  step: Step;
  attempt: AttemptView;
  model: ReportModel;
  videos: readonly TimedVideo[];
  playing: boolean;
  onSeek: (step: Step) => void;
}) {
  const [open, setOpen] = useState(step.status !== 'passed' && step.status !== 'cancelled');
  const position = videoPosition(step, videos);
  const screenshots = attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot' && step.artifacts.includes(artifact.id));
  const appLog = attempt.appLog.filter((line) => line.step === step.index);
  const actions = step.events.filter((event) => event.kind === 'engine' && event.detail !== undefined);
  // The step that failed the attempt carries the attempt's error, already shown above the steps.
  const error = step.error?.message === attempt.error?.message ? undefined : step.error;
  const hasDetail =
    hasFrame(step.source, model) ||
    step.explanation !== undefined ||
    error !== undefined ||
    step.model !== undefined ||
    (step.turns?.length ?? 0) > 0 ||
    (step.screen?.changes.length ?? 0) > 0 ||
    actions.length > 0 ||
    screenshots.length > 0 ||
    appLog.length > 0;

  return (
    <li className={`border-b border-shade-800 ${playing ? 'bg-playhead/5 shadow-[inset_2px_0_0_var(--color-playhead)]' : ''}`}>
      <div className="flex items-center gap-e2e-1 px-e2e-1 py-e2e-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-e2e-1 text-left disabled:cursor-default"
          aria-expanded={hasDetail ? open : undefined}
          disabled={!hasDetail}
          onClick={() => setOpen(!open)}
        >
          <span className={`text-shade-600 ${hasDetail ? '' : 'invisible'}`}>
            <Icon name={open ? 'disclosure-open' : 'disclosure-closed'} />
          </span>
          <StepStatusIcon status={step.status} />
          <span className="type-code-s shrink-0 text-shade-400">{step.api}</span>
          <span className="type-body-s min-w-0 truncate">{step.label}</span>
        </button>
        {step.phase === undefined ? null : <Tag hint={PHASE_HINT[step.phase]}>{step.phase}</Tag>}
        {step.cache === undefined ? null : (
          <Tag tone={step.cache.mode === 'missed' ? undefined : 'mint'} hint={CACHE_HINT[step.cache.mode]}>
            {CACHE_LABEL[step.cache.mode]}
          </Tag>
        )}
        {step.model === undefined ? null : (
          <span className="type-caption text-shade-500">{formatTokens(step.model.inputTokens + step.model.outputTokens)} tok</span>
        )}
        <span className="type-caption w-16 shrink-0 text-right text-shade-500">{formatDuration(step.durationMs)}</span>
        {position === undefined ? null : (
          <button
            type="button"
            className="e2e-action flex w-20 shrink-0 items-center justify-end gap-e2e-half"
            aria-label={`Play the video from this step, at ${formatClock(position.seconds)}`}
            onClick={() => onSeek(step)}
          >
            <Icon name="play" />
            {formatClock(position.seconds)}
          </button>
        )}
      </div>
      {open && hasDetail ? (
        <div className="flex flex-col gap-e2e-2 pr-e2e-1 pb-e2e-2 pl-e2e-6">
          {error === undefined ? null : <ErrorBlock error={error} model={model} />}
          {hasFrame(step.source, model) ? <CodeFrame source={step.source} model={model} failed={step.status !== 'passed' && step.status !== 'cancelled'} /> : null}
          {step.explanation === undefined ? null : (
            <Detail label="explanation">
              <p className="type-body-s text-shade-200">{step.explanation}</p>
            </Detail>
          )}
          {actions.length === 0 ? null : (
            <Detail label="actions">
              <ol className="type-code-s list-inside list-decimal text-shade-300">
                {actions.map((event) => (
                  <li key={`${event.startedAt}:${event.detail}`} className={event.status === 'passed' ? '' : 'text-status-failed'}>
                    {event.detail}
                  </li>
                ))}
              </ol>
            </Detail>
          )}
          {step.model === undefined ? null : (
            <Detail label="model">
              <p className="type-code-s text-shade-300">
                {step.model.provider}/{step.model.model} · {step.model.calls} {step.model.calls === 1 ? 'call' : 'calls'} · {formatTokens(step.model.inputTokens)} in
                {step.model.cacheReadTokens === undefined ? '' : ` (${formatTokens(step.model.cacheReadTokens)} cached)`} · {formatTokens(step.model.outputTokens)} out
                {step.model.estimatedCostUsd === undefined ? '' : ` · ${formatCost(step.model.estimatedCostUsd)}`}
              </p>
            </Detail>
          )}
          {step.cache?.detail === undefined ? null : (
            <Detail label="cache">
              <p className="type-code-s text-shade-300">
                {step.cache.replayedActions}/{step.cache.totalActions} actions replayed{step.cache.reason === undefined ? '' : ` · ${step.cache.reason}`} · {step.cache.detail}
              </p>
            </Detail>
          )}
          {step.turns === undefined || step.turns.length === 0 ? null : (
            <Detail label="agent turns">
              <ol className="flex flex-col gap-e2e-1">
                {step.turns.map((turn) => (
                  <li key={turn.index} className="type-code-s">
                    <span className="text-shade-500">{turn.index}. </span>
                    <span className="text-mint">{turn.calls.join(', ')}</span>
                    <pre className="whitespace-pre-wrap text-shade-400">{turn.outcome}</pre>
                  </li>
                ))}
              </ol>
            </Detail>
          )}
          {step.screen === undefined || step.screen.changes.length === 0 ? null : (
            <Detail label={`screen${step.screen.location === undefined ? '' : ` · ${step.screen.location}`}`}>
              <pre className="type-code-s overflow-x-auto text-shade-300">
                {step.screen.changes.map((line) => (
                  <span key={line} className={`block ${line.startsWith('+') ? 'text-status-passed' : line.startsWith('-') ? 'text-status-failed' : ''}`}>
                    {line}
                  </span>
                ))}
                {step.screen.more === undefined ? null : <span className="block text-shade-500">… {step.screen.more} more</span>}
              </pre>
            </Detail>
          )}
          {appLog.length === 0 ? null : (
            <Detail label="app log">
              <pre className="type-code-s whitespace-pre-wrap text-shade-300">{appLog.map((line) => line.text).join('\n')}</pre>
            </Detail>
          )}
          {screenshots.length === 0 ? null : (
            <div className="grid grid-cols-2 gap-e2e-1">
              {screenshots.map((artifact) => (
                <Screenshot key={artifact.id} artifact={artifact} model={model} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-e2e-half">
      <span className="type-caption text-shade-500">{label}</span>
      {children}
    </div>
  );
}

function FailureEvidence({ attempt, model }: { attempt: AttemptView; model: ReportModel }) {
  const { failure } = attempt;
  if (failure === undefined) return null;
  const find = (id: string | undefined) => (id === undefined ? undefined : attempt.artifacts.find((artifact) => artifact.id === id));
  const screenshot = find(failure.screenshot);
  const screen = find(failure.screen);
  return (
    <section aria-label="At failure" className="flex flex-col gap-e2e-1">
      <h2 className="type-caption text-shade-500">at failure</h2>
      {failure.url === undefined ? null : <span className="type-code-s truncate text-shade-300">{failure.url}</span>}
      {screenshot === undefined ? null : <Screenshot artifact={screenshot} model={model} />}
      {screen === undefined ? null : <ArtifactLink artifact={screen} model={model} label={`screen at failure${failure.nodes === undefined ? '' : ` (${failure.nodes} nodes)`}`} />}
      {failure.candidates === undefined || failure.candidates.length === 0 ? null : (
        <Detail label="closest on screen">
          <pre className="type-code-s overflow-x-auto text-shade-300">{failure.candidates.join('\n')}</pre>
        </Detail>
      )}
    </section>
  );
}

function Screenshot({ artifact, model }: { artifact: Artifact; model: ReportModel }) {
  const url = artifactUrl(artifact, model.media);
  if (url === undefined) return null;
  const name = artifact.path?.split('/').at(-1) ?? artifact.id;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="e2e-panel block w-fit max-w-full">
      <img src={url} alt={name} loading="lazy" className="block max-h-[32rem] max-w-full" />
    </a>
  );
}

function ArtifactLink({ artifact, model, label }: { artifact: Artifact; model: ReportModel; label?: string }) {
  const url = artifactUrl(artifact, model.media);
  const name = label ?? artifact.path?.split('/').at(-1) ?? artifact.id;
  if (url === undefined) return <span className="type-code-s text-shade-500">{name}</span>;
  // A download is the app's bytes: saved, never opened, so an HTML one cannot run where the report is hosted.
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      download={artifact.kind === 'download' ? name : undefined}
      className="type-code-s text-shade-300 underline decoration-shade-600 underline-offset-4"
    >
      {name}
    </a>
  );
}
