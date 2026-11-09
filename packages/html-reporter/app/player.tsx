import { useState, type RefObject } from 'react';
import { formatClock, videoPosition, type Step, type TimedVideo } from './data.ts';
import { Icon } from './ui.tsx';

const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

/** A recording's size in pixels. */
export interface VideoShape {
  readonly width: number;
  readonly height: number;
}

/** A phone recording: taller than wide, laid out beside the steps. */
export function isPortrait(shape: VideoShape): boolean {
  return shape.height > shape.width;
}

/** Seconds a short recording should take to play, so its steps can be followed by eye. */
const MIN_WATCH_SECONDS = 5;

/** The speed a recording starts at: the fastest, up to 1×, that plays it for at least `MIN_WATCH_SECONDS`. */
function defaultSpeed(duration: number): number {
  if (duration <= 0) return 1;
  return SPEEDS.findLast((speed) => speed <= 1 && duration / speed >= MIN_WATCH_SECONDS) ?? SPEEDS[0];
}

/**
 * The attempt's video with our own controls: play, a timeline marked at
 * every step's start, the clock, playback speed, recording parts, and full
 * screen. `videoRef` stays with the caller, which seeks it from the step list.
 */
export function VideoPlayer({
  videos,
  index,
  onIndexChange,
  videoRef,
  steps,
  playingStep,
  onPlayhead,
  shape,
  onShape,
}: {
  videos: readonly TimedVideo[];
  index: number;
  onIndexChange: (index: number) => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  steps: readonly Step[];
  playingStep: Step | undefined;
  onPlayhead: (at: number) => void;
  /**
   * The recording's size, guessed by the caller until the file says. The
   * player keeps that shape while it loads, so the page does not jump, and
   * reports the real one.
   */
  shape: VideoShape;
  onShape: (shape: VideoShape) => void;
}) {
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Until a speed is picked, each recording plays at the one its length calls for.
  const [chosenSpeed, setChosenSpeed] = useState<number | undefined>(undefined);
  const video = videos[index];
  if (video === undefined) return null;
  const speed = chosenSpeed ?? defaultSpeed(duration);
  // One button steps through the speeds, slowest again after the fastest.
  const nextSpeed = SPEEDS[(SPEEDS.findIndex((candidate) => candidate === speed) + 1) % SPEEDS.length]!;
  const portrait = isPortrait(shape);

  // Where each step starts on this part's timeline.
  const markers = steps.flatMap((step) => {
    const position = videoPosition(step, videos);
    return position?.video === index ? [{ id: step.id, seconds: position.seconds }] : [];
  });
  const percent = (seconds: number) => `${duration > 0 ? Math.min(100, (seconds / duration) * 100) : 0}%`;

  const toggle = () => {
    const element = videoRef.current;
    if (element === null) return;
    if (element.paused) void element.play();
    else element.pause();
  };

  // A recording without a duration in its header reports Infinity; the seekable range still ends where the file does.
  const readDuration = (element: HTMLVideoElement) => {
    const end = Number.isFinite(element.duration) ? element.duration : element.seekable.length > 0 ? element.seekable.end(0) : 0;
    setDuration(end);
    element.playbackRate = chosenSpeed ?? defaultSpeed(end);
    if (element.videoWidth > 0 && (element.videoWidth !== shape.width || element.videoHeight !== shape.height)) {
      onShape({ width: element.videoWidth, height: element.videoHeight });
    }
  };

  return (
    <section aria-label="Video" className={`e2e-panel flex w-full flex-col ${portrait ? 'max-w-[22rem] md:sticky md:top-e2e-4' : 'max-w-3xl'}`}>
      <video
        ref={videoRef}
        key={video.url}
        src={video.url}
        muted
        playsInline
        style={{ aspectRatio: `${shape.width} / ${shape.height}` }}
        className={`w-full cursor-pointer bg-shade-900 object-contain [:fullscreen_&]:max-h-none [:fullscreen_&]:min-h-0 [:fullscreen_&]:flex-1 ${portrait ? 'max-h-[75vh]' : 'max-h-[50vh]'}`}
        onClick={toggle}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onLoadStart={() => {
          // Another part's clock and timeline must not show while this one loads.
          setTime(0);
          setDuration(0);
        }}
        onLoadedMetadata={(event) => readDuration(event.currentTarget)}
        onDurationChange={(event) => readDuration(event.currentTarget)}
        onTimeUpdate={(event) => {
          setTime(event.currentTarget.currentTime);
          onPlayhead(video.startsAt + event.currentTarget.currentTime * 1000);
        }}
      />
      <div className="flex flex-col gap-e2e-1 border-t border-shade-700 px-e2e-2 py-e2e-1">
        <div className="relative h-e2e-2">
          <div className="absolute inset-x-0 top-1/2 h-px bg-shade-600" />
          <div className="absolute top-1/2 left-0 h-[3px] -translate-y-px bg-playhead" style={{ width: percent(time) }} />
          {markers.map((marker) => (
            <span
              key={marker.id}
              className={`absolute top-1/2 h-e2e-1 w-px -translate-y-1/2 ${marker.id === playingStep?.id ? 'bg-playhead' : 'bg-shade-400'}`}
              style={{ left: percent(marker.seconds) }}
            />
          ))}
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={duration}
            step={0.1}
            value={time}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            onChange={(event) => {
              const element = videoRef.current;
              if (element === null) return;
              element.currentTime = Number(event.currentTarget.value);
            }}
          />
        </div>
        <div className="flex items-center gap-e2e-2">
          <button type="button" className="e2e-action" aria-label={paused ? 'Play' : 'Pause'} onClick={toggle}>
            <Icon name={paused ? 'play' : 'pause'} />
          </button>
          <span className="type-caption shrink-0 tabular-nums text-shade-300">
            {formatClock(time)} / {formatClock(duration)}
          </span>
          <span className="flex-1" />
          {videos.length > 1 ? (
            <div className="flex gap-e2e-1" role="group" aria-label="Recording part">
              {videos.map((candidate, partIndex) => (
                <button
                  key={candidate.artifact.id}
                  type="button"
                  className="e2e-action"
                  aria-pressed={partIndex === index}
                  onClick={() => onIndexChange(partIndex)}
                >
                  part {partIndex + 1}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="e2e-action w-10 text-right tabular-nums text-shade-300"
            aria-label={`Playback speed: ${speed}×`}
            title="Playback speed"
            onClick={() => {
              setChosenSpeed(nextSpeed);
              if (videoRef.current !== null) videoRef.current.playbackRate = nextSpeed;
            }}
          >
            {speed}×
          </button>
          <button
            type="button"
            className="e2e-action"
            aria-label="Full screen"
            onClick={(event) => {
              const player = event.currentTarget.closest('section');
              if (document.fullscreenElement !== null) void document.exitFullscreen();
              else void player?.requestFullscreen();
            }}
          >
            <Icon name="expand" />
          </button>
        </div>
        {/* Its own line, kept when empty, so the controls above never move as steps change. */}
        <p className="type-code-s min-h-[1lh] truncate text-shade-400">
          {playingStep === undefined ? null : (
            <>
              <span className="text-shade-500">{playingStep.api}</span> {playingStep.label}
            </>
          )}
        </p>
      </div>
    </section>
  );
}
