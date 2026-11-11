import { packageVersion } from '../../internal/package-version.ts';
import { getEnginePreset, type EngineId, type EnginePreset } from './engines.ts';
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

/** One test file the scaffold writes, as `tests/<name>.e2e.ts`. */
interface ScaffoldTest {
  readonly name: string;
  readonly content: string;
}

const NO_ENGINE_CONFIG = `  // Add an engine here when your tests need to drive an app.
  targets: [{ name: 'default', platform: 'custom' }],`;

const NO_ENGINE_EXAMPLE = `import { test, expect } from 'e2e';

test('app responds', async () => {
  const response = await fetch(process.env.APP_URL ?? 'http://localhost:3000');
  expect(response.ok).toBe(true);
});
`;

/** Every line of `text` after the first indented by `prefix`, for a block nested one level deeper. */
function indentTail(text: string, prefix: string): string {
  return text.replaceAll('\n', `\n${prefix}`);
}

/**
 * The `targets` field and the settings the engines add. One engine keeps its
 * target inline; several get one entry each, and a setting two engines share
 * is written once.
 */
function targetsConfig(engines: readonly EnginePreset[]): string {
  const [engine, ...others] = engines;
  if (engine === undefined) return NO_ENGINE_CONFIG;
  const settings = [...new Set(engines.flatMap((preset) => preset.settings))];
  if (others.length === 0) {
    return [
      ...(engine.targetComment === undefined ? [] : [`  // ${engine.targetComment}`]),
      `  targets: [${indentTail(engine.target, '  ')}],`,
      ...settings,
    ].join('\n');
  }
  return [
    '  targets: [',
    ...engines.flatMap((preset) => [
      ...(preset.targetComment === undefined ? [] : [`    // ${preset.targetComment}`]),
      `    ${indentTail(preset.target, '    ')},`,
    ]),
    '  ],',
    ...settings,
  ].join('\n');
}

/**
 * The example tests. One engine writes `tests/example.e2e.ts`; several write
 * one file per engine, each test requiring its engine's fixture so the other
 * engines' targets skip it.
 */
function exampleTests(engines: readonly EnginePreset[], ai: boolean): ScaffoldTest[] {
  const [engine, ...others] = engines;
  if (engine === undefined) return [{ name: 'example', content: NO_ENGINE_EXAMPLE }];
  if (others.length === 0) return [{ name: 'example', content: engine.example('') + (ai ? engine.aiExample('') : '') }];
  return engines.map((preset) => {
    const options = `{ requires: ['${preset.fixture}'] }, `;
    return { name: preset.file, content: preset.example(options) + (ai ? preset.aiExample(options) : '') };
  });
}

/** Composes common setup, the selected engines (none for an engine-less config), and optional AI support. */
export function createScaffold(engineIds: readonly EngineId[], model: ScaffoldModel | undefined) {
  const engines = engineIds.map(getEnginePreset);
  const gateway = model === undefined ? undefined : getGatewayPreset(model.gateway);
  const imports = [
    "import type { E2EConfig } from 'e2e';",
    ...engines.flatMap((engine) => engine.imports),
    ...(gateway === undefined ? [] : [gateway.import]),
  ];
  const configFields = [
    ...(model === undefined ? [] : [agentConfig(model)]),
    targetsConfig(engines),
  ];

  return {
    dependencies: {
      'e2e': dependencyRange(packageVersion(import.meta.url, '../../../package.json', '0.0.0')),
      ...Object.fromEntries(engines.flatMap((engine) => Object.entries(engine.dependencies))),
      // zod is a peer of `ai` and every provider; npm and pnpm install peers, Yarn does not.
      ...(gateway === undefined ? {} : { ai: '^7.0.0', zod: '^4.1.8', ...gateway.dependencies }),
    },
    config: `${imports.join('\n')}

export default {
${configFields.join('\n')}
} satisfies E2EConfig;
`,
    tests: exampleTests(engines, gateway !== undefined),
    // An engine-less config's example fetches APP_URL too.
    needsAppUrl: engines.length === 0 || engines.some((engine) => engine.needsAppUrl),
  };
}
