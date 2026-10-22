import type { E2EConfig } from 'e2e';
import { ocrExecutor, tesseractOcr } from 'e2e/ocr';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: {
    default: {
      executor: ocrExecutor({
        provider: tesseractOcr(),
        async runStep(context, ocr) {
          if (context.step.kind === 'act' && context.step.instruction === 'tap Continue') {
            await ocr.tapText({ text: 'Continue' });
            return { status: 'passed', summary: 'Tapped the unique Continue line.' };
          }
          if (context.step.kind === 'assert' && context.step.instruction === 'Ready is visible') {
            await ocr.assertText({ text: 'Ready' });
            return { status: 'passed', summary: 'Recognized a unique Ready line.' };
          }
          return {
            status: 'blocked',
            errorCode: 'AUTOMATION_UNSUPPORTED',
            summary: 'This executor only supports tap Continue and Ready is visible.',
          };
        },
      }),
    },
  },
} satisfies E2EConfig;
