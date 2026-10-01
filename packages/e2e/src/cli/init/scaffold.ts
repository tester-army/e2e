import { packageVersion } from '../../internal/package-version.ts';
import { getEnginePreset, type EngineId } from './engines.ts';
import { dependencyRange } from './versions.ts';
import { getGatewayPreset, type GatewayId } from './gateways.ts';

/** The model choice `init` writes: which gateway, and for an OpenAI-compatible one, where. */
export interface ScaffoldModel {
  readonly gateway: GatewayId;
  readonly endpoint?: string;
}

/**
 * The agents block. The model is a constructed AI SDK instance from the chosen
 * gateway's own package, written out in full, so a reader sees where every
 * model call goes and which variable holds the key without knowing any e2e
 * default; there is none.
 */
function agentConfig(model: ScaffoldModel): string {
  const preset = getGatewayPreset(model.gateway);
  return `  // ${preset.comment}
  agents: {
    default: {
      model: ${preset.model(model.endpoint)},
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },`;
}

/** Composes common setup, the selected engine, and optional AI support. */
export function createScaffold(engineId: EngineId, model: ScaffoldModel | undefined) {
  const engine = getEnginePreset(engineId);
  const gateway = model === undefined ? undefined : getGatewayPreset(model.gateway);
  const imports = [
    "import type { E2EConfig } from 'e2e';",
    ...engine.imports,
    ...(gateway === undefined ? [] : [gateway.import]),
  ];
  const configFields = [
    ...(model === undefined ? [] : [agentConfig(model)]),
    engine.config,
  ];

  return {
    dependencies: {
      'e2e': dependencyRange(packageVersion(import.meta.url, '../../../package.json', '0.0.0')),
      ...engine.dependencies,
      // zod is a peer of `ai` and every provider; npm and pnpm install peers, Yarn does not.
      ...(gateway === undefined ? {} : { ai: '^7.0.0', zod: '^4.1.8', ...gateway.dependencies }),
    },
    config: `${imports.join('\n')}

export default {
${configFields.join('\n')}
} satisfies E2EConfig;
`,
    example: engine.example + (gateway === undefined ? '' : engine.aiExample ?? ''),
    needsAppUrl: engine.needsAppUrl,
  };
}
