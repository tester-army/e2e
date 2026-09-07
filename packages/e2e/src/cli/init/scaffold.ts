import { packageVersion } from '../../internal/package-version.ts';
import { getEnginePreset, type EngineId } from './engines.ts';

const AGENT_IMPORT = "import { createAgent } from '@e2edev/e2e/agent';";
const AGENT_CONFIG = `  // The model comes from E2E_MODEL; authenticate with E2E_MODEL_API_KEY.
  agent: createAgent({
    system: 'You are a thorough QA agent. Verify every outcome.',
  }),`;

/** Composes common setup, the selected engine, and optional AI support. */
export function createScaffold(engineId: EngineId, ai: boolean) {
  const engine = getEnginePreset(engineId);
  const imports = [
    "import type { E2EConfig } from '@e2edev/e2e';",
    ...(ai ? [AGENT_IMPORT] : []),
    ...engine.imports,
  ];
  const configFields = [
    ...(ai ? [AGENT_CONFIG] : []),
    engine.config,
  ];

  return {
    dependencies: {
      '@e2edev/e2e': `^${packageVersion(import.meta.url, '../../../package.json', '0.0.0')}`,
      ...engine.dependencies,
      ...(ai ? { ai: '^7.0.0' } : {}),
    },
    config: `${imports.join('\n')}

export default {
${configFields.join('\n')}
} satisfies E2EConfig;
`,
    example: engine.example + (ai ? engine.aiExample ?? '' : ''),
    runCommand: engine.runCommand,
  };
}
