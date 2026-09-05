import { packageVersion } from '../../internal/package-version.ts';
import { getBackendPreset, type BackendId } from './backends.ts';

const AGENT_IMPORT = "import { createAgent } from '@e2edev/e2e/agent';";
const AGENT_CONFIG = `  // The model comes from E2E_MODEL; authenticate with E2E_MODEL_API_KEY.
  agent: createAgent({
    system: 'You are a thorough QA agent. Verify every outcome.',
  }),`;

/** Composes common setup, the selected backend, and optional AI support. */
export function createScaffold(backendId: BackendId, ai: boolean) {
  const backend = getBackendPreset(backendId);
  const imports = [
    "import { defineConfig } from '@e2edev/e2e';",
    ...(ai ? [AGENT_IMPORT] : []),
    ...backend.imports,
  ];
  const configFields = [
    ...(ai ? [AGENT_CONFIG] : []),
    backend.config,
  ];

  return {
    dependencies: {
      '@e2edev/e2e': `^${packageVersion(import.meta.url, '../../../package.json', '0.0.0')}`,
      ...backend.dependencies,
      ...(ai ? { ai: '^7.0.0' } : {}),
    },
    config: `${imports.join('\n')}

export default defineConfig({
${configFields.join('\n')}
});
`,
    example: backend.example + (ai ? backend.aiExample ?? '' : ''),
    runCommand: backend.runCommand,
  };
}
