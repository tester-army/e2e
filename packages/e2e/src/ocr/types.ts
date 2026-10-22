import type { ExecutorObservation, PointTapResult, StepExecutorContext, StepVerdict } from '../agent/executor.ts';

/** A full-viewport, already-masked PNG, possibly downscaled by the harness. Providers must not crop or rotate it. */
export interface OcrImage {
  readonly data: Uint8Array;
  readonly mediaType: 'image/png';
  readonly width: number;
  readonly height: number;
}

/** A rectangle in the coordinate space documented by its containing type. */
export interface OcrRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A recognized line and its rectangle in input-image pixels, confidence in [0, 1]. */
export interface OcrBox {
  readonly text: string;
  readonly confidence: number;
  readonly rect: OcrRect;
}

/** Trusted project code; receives only captures the harness permits. The built-in adapter is local. */
export interface OcrProvider {
  readonly name: string;
  recognize(image: OcrImage, options: { readonly signal: AbortSignal }): Promise<readonly OcrBox[]>;
}

/** One OCR result; rectangles and points use the engine's logical viewport coordinates. */
export interface OcrMatch extends OcrBox {
  readonly point: { readonly x: number; readonly y: number };
}

/** Read-only evidence from one capture. OCR never adds nodes to the semantic tree. */
export interface OcrReading {
  readonly revision: string;
  readonly viewport: ExecutorObservation['viewport'];
  readonly matches: readonly OcrMatch[];
}

/** Text to find within one recognized line. Multiple matches always require a narrower region. */
export interface OcrQuery {
  readonly text: string;
  /** Whole-line match by default; false allows a substring of a line. */
  readonly exact?: boolean;
  /** Case-insensitive by default; whitespace is always collapsed. */
  readonly caseSensitive?: boolean;
  /** Minimum confidence, from 0 to 1; defaults to 0.8. */
  readonly minConfidence?: number;
  /** Only boxes fully contained in this logical viewport rectangle count. */
  readonly region?: OcrRect;
}

/** Bounds apply to every read, including the fresh capture used to validate a tap. */
export interface OcrOptions {
  readonly provider: OcrProvider;
  /** Capture plus recognition budget per call; defaults to 10,000 ms. */
  readonly timeoutMs?: number;
  /** Maximum age of a tap's initial capture; defaults to 2,000 ms. */
  readonly maxAgeMs?: number;
}

/** Methods capture anew, queue in call order, and honor the step's signal and budgets. */
export interface OcrWorkflow {
  read(): Promise<OcrReading>;
  locate(query: OcrQuery): Promise<OcrMatch>;
  assertText(query: OcrQuery): Promise<OcrMatch>;
  /** Only in act steps. Revalidates pixels before dispatch through the harness's tapAt. */
  tapText(query: OcrQuery): Promise<PointTapResult>;
}

/** Step metadata only; all UI operations go through the workflow's shared queue. */
export type OcrExecutorContext = Pick<StepExecutorContext, 'step' | 'signal' | 'target' | 'attempt'>;

/** An opt-in executor with OCR helpers. Cache is off only for this executor's steps. */
export interface OcrExecutorOptions extends OcrOptions {
  readonly name?: string;
  runStep(context: OcrExecutorContext, ocr: OcrWorkflow): Promise<StepVerdict>;
}
