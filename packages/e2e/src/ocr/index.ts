/** Opt-in local OCR; imports no AI SDK and changes neither the default engine nor its semantic tree. */
export { ocrExecutor } from './workflow.ts';
export { ocrTools } from './tools.ts';
export { tesseractOcr, type TesseractOcrOptions } from './tesseract.ts';
export type { OcrImage, OcrRect, OcrBox, OcrProvider, OcrMatch, OcrReading, OcrQuery, OcrOptions, OcrWorkflow, OcrExecutorContext, OcrExecutorOptions } from './types.ts';
