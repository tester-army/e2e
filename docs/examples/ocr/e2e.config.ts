import type { E2EConfig } from 'e2e';
import { ocrTools, tesseractOcr } from 'e2e/ocr';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      tools: { ...ocrTools({ provider: tesseractOcr() }) },
    },
  },
} satisfies E2EConfig;
