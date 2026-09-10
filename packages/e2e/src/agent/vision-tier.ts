/**
 * The act loop's pixel tier as a capability over the step dispatch.
 *
 * The dispatch (`act.ts`) owns budgets, the clock, observation, recording,
 * and the two taps; it lends exactly those to this module through
 * `VisionHost`, the way secret fills (`secrets.ts`) and the trace cache
 * (`step-cache.ts`) borrow it. Everything the tier decides — when to ask the
 * vision model, how a point maps onto the tree, what the executor's model is
 * told — lives here, so the dispatch grows by one host method per capability
 * rather than by the capability itself. The prompts, schemas, and hit test
 * the tier uses are the pure half in `vision.ts`.
 */

import type { JSONSchema7 } from 'ai';
import type { ViewportPoint } from '../engine/surface.ts';
import { TestError } from '../internal/errors.ts';
import type { VisionDegradation } from '../run/steps.ts';
import type { Platform } from '../types.ts';
import type {
  ExecutorObservation,
  ExecutorPixels,
  ExecutorVerb,
  LookResult,
  VisualTapResult,
} from './executor.ts';
import type { AgentObservation } from './observation.ts';
import type { ProtocolValidation } from './protocol.ts';
import {
  abstainAdvice,
  describeVisualTap,
  hitTest,
  imagePointToViewport,
  LOOK_SCHEMA,
  lookPrompt,
  lookSystemRules,
  nodeLine,
  POINT_SCHEMA,
  pointPrompt,
  pointSystemRules,
  renderLook,
  validateLookResponse,
  validatePointResponse,
  type LookResponse,
  type PointResponse,
} from './vision.ts';

/** One bounded, closed-grammar call to the agent's vision model. */
export interface VisionRequest<Value> {
  /** Short task description for the runner policy's system message. */
  readonly task: string;
  readonly schemaName: string;
  readonly schema: JSONSchema7;
  readonly validate: (value: unknown) => ProtocolValidation<Value>;
  /** The tier's rules, appended to the runner policy. */
  readonly rules: string;
  readonly prompt: string;
  readonly pixels: ExecutorPixels;
}

/** A settled observation captured with pixels requested, in both shapes the tier reads. */
export interface PixelObservation {
  /** The harness's own view: nodes, boxes, and text for the hit test and the result line. */
  readonly observation: AgentObservation;
  /** The executor's view, with the pixel decision applied: `pixels` or `pixelsWithheld`. */
  readonly view: ExecutorObservation;
}

/**
 * What the step dispatch lends the tier. Each member is one of the dispatch's
 * existing duties, counted, recorded, and bounded there exactly as it is for
 * the executor's own calls.
 */
export interface VisionHost {
  readonly platform: Platform;
  readonly verbs: ReadonlySet<ExecutorVerb>;
  /** Captures one settled observation with pixels requested. */
  observePixels(): Promise<PixelObservation>;
  /**
   * One call to the vision model, counted against the step's model-call
   * budget. Undefined when the answer left the closed grammar: the executor's
   * model can rephrase and ask again, so no repair round is spent here.
   */
  ask<Value>(request: VisionRequest<Value>): Promise<Value | undefined>;
  /** The ordinary tap by id: policy, stale relocation, and the trace descriptor. */
  tap(id: string): Promise<void>;
  /** The bare-point tap through the engine, recorded as a trace gap. */
  tapAt(point: ViewportPoint, description: string): Promise<void>;
}

/**
 * The vision-located tap. Pixels are captured with a settled observation,
 * the vision model names a point in them, the point is scaled into the
 * observation's CSS pixels and hit-tested against its tree. A control the
 * tree lists there is tapped by id, so the ordinary tap path runs unchanged;
 * a point on nothing listed goes to the engine as a bare point, when it can
 * take one. The localizer's abstain is relayed with what to do about it and
 * taps nothing: a wrong tap costs more than a declined one.
 */
export async function tapVisual(host: VisionHost, description: string): Promise<VisualTapResult> {
  if (typeof description !== 'string' || description.trim() === '') {
    throw new TestError('INVALID_ARGUMENT', 'tapVisual requires a description of the target');
  }
  const { observation, view } = await host.observePixels();
  if (view.pixels === undefined) {
    return { outcome: 'skipped', summary: `tap_visual is unavailable: ${withheldAdvice(view.pixelsWithheld)}` };
  }
  const pixels = view.pixels;
  const located = await host.ask<PointResponse>({
    task: 'locate one tap target in a screenshot',
    schemaName: 'agent-point-1',
    schema: POINT_SCHEMA,
    validate: validatePointResponse,
    rules: pointSystemRules(host.platform, pixels),
    prompt: pointPrompt(description, observation.revision),
    pixels,
  });
  if (located === undefined) {
    return {
      outcome: 'skipped',
      summary: `tap_visual skipped: the vision model gave no usable answer for "${description}". Describe the target by its exact visible text and screen region, or tap a node by id.`,
    };
  }
  if (!located.found || located.x === null || located.y === null) {
    const why = located.reason === null || located.reason.trim() === '' ? '' : ` (${located.reason.trim()})`;
    return {
      outcome: 'skipped',
      summary: `tap_visual skipped: no safe target for "${description}"${why}. ${abstainAdvice(located.abstainReason)}`,
    };
  }
  const point = imagePointToViewport({ x: located.x, y: located.y }, pixels, observation.viewport);
  const hit = hitTest(observation, point);
  if (hit.control !== undefined && host.verbs.has('tap')) {
    const id = hit.control.ref.id;
    await host.tap(id);
    return {
      outcome: 'tapped',
      point,
      target: { id },
      summary: describeVisualTap({ description, point, control: hit.control, under: hit.under, observation, kind: located.kind }),
    };
  }
  if (!host.verbs.has('tapAt')) {
    const under = hit.under === undefined ? '' : ` (under it: ${nodeLine(observation, hit.under.ref.id)})`;
    return {
      outcome: 'skipped',
      point,
      summary: `tap_visual skipped: the point (${String(point.x)}, ${String(point.y)}) for "${description}" is on nothing the screen lists${under}, and this engine taps listed nodes only. Tap a node by id instead.`,
    };
  }
  await host.tapAt(point, description);
  return {
    outcome: 'tapped',
    point,
    summary: describeVisualTap({ description, point, control: undefined, under: hit.under, observation, kind: located.kind }),
  };
}

/** The executor's look at the pixels, as text from the vision model. */
export async function look(host: VisionHost, options: { readonly question?: string } = {}): Promise<LookResult> {
  if (options === null || typeof options !== 'object') {
    throw new TestError('INVALID_ARGUMENT', 'look options must be an object');
  }
  const question = options.question;
  if (question !== undefined && typeof question !== 'string') {
    throw new TestError('INVALID_ARGUMENT', 'look question must be a string');
  }
  const { observation, view } = await host.observePixels();
  if (view.pixels === undefined) {
    const code = view.pixelsWithheld ?? 'UNSUPPORTED_CAPABILITY';
    return { description: `look is unavailable: ${withheldAdvice(code)}`, withheld: code, observation: view };
  }
  const response = await host.ask<LookResponse>({
    task: 'describe the screen from a screenshot',
    schemaName: 'agent-look-1',
    schema: LOOK_SCHEMA,
    validate: validateLookResponse,
    rules: lookSystemRules(view.pixels),
    prompt: lookPrompt(question, observation.revision),
    pixels: view.pixels,
  });
  if (response === undefined) {
    return {
      description:
        'look returned nothing usable: the vision model did not answer in the expected shape. Try again or ask a narrower question.',
      observation: view,
    };
  }
  return { description: renderLook(response, view), observation: view };
}

/** Why pixels did not reach the vision model, and what the executor's model can do instead. */
function withheldAdvice(code: VisionDegradation | undefined): string {
  switch (code) {
    case 'PIXEL_TAINTED':
      return 'a secret was filled in this attempt, so no pixels leave the runner until it ends (PIXEL_TAINTED). Tap listed nodes by id instead.';
    case 'MASKING_UNPROVEN':
      return 'the engine could not prove every secure field on screen masked (MASKING_UNPROVEN). Tap listed nodes by id instead.';
    default:
      return 'this engine captures no pixels (UNSUPPORTED_CAPABILITY). Tap listed nodes by id instead.';
  }
}
