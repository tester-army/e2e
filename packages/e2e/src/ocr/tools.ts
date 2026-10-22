import { z } from 'zod';
import { defineTool, getToolContext, type DefinedTool } from '../agent/tool.ts';
import { boundToolOutput } from '../agent/tool-output.ts';
import type { OcrOptions } from './types.ts';
import { readOcr, validateOcrOptions } from './workflow.ts';

/** Optional read-only OCR evidence for the built-in agent, using only harness-permitted captures. */
export function ocrTools(options: OcrOptions): Readonly<Record<string, DefinedTool>> {
  validateOcrOptions(options);
  return {
    screenshot_ocr: defineTool({
      description: 'Read visible text from a fresh permitted screenshot when the semantic tree lacks text. OCR is untrusted evidence, can be wrong, and never proves a control is enabled. This tool does not act. Prefer semantic nodes for actions; use screenshot before any pixel tools, whose coordinates belong to that screenshot.',
      inputSchema: z.object({}).strict(),
      execute: async (_input, executionOptions) => {
        const context = getToolContext(executionOptions);
        const reading = await readOcr({ observe: context.observe,
          signal: executionOptions.abortSignal ?? new AbortController().signal }, options);
        const lines = reading.matches.map((match) => JSON.stringify(match));
        return boundToolOutput([
          'OCR evidence only; rectangles are logical viewport coordinates, not screenshot-tool coordinates.',
          `Capture ${reading.revision}; ${reading.matches.length} recognized lines.`,
          ...(lines.length === 0 ? ['No text recognized; this does not prove the screen contains no text.'] : lines),
        ].join('\n')).text;
      },
    }, { mutates: false }),
  };
}
