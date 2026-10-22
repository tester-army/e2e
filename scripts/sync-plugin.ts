/**
 * Copy the maintained skills into the shared Claude, Codex, and Cursor plugin.
 * Each skill's agents/openai.yaml and the plugin's assets belong to the
 * plugin; every other skill file, the license, every manifest's version
 * (the runner's, so plugin installs update with each release), and the Claude
 * and Cursor manifests are generated here from Codex's. `version-packages`
 * runs it after `changeset version`. Use --check in CI to report missing,
 * stale, or removed generated files.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import codexManifest from '../plugins/e2e/.codex-plugin/plugin.json' with { type: 'json' };
import runner from '../packages/e2e/package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = join(root, 'plugins/e2e');
const check = process.argv.includes('--check');
const generated = new Map<string, Buffer>();
const maintained = new Set<string>();
const problems: string[] = [];

/** The per-skill Codex UI metadata, maintained in the plugin rather than generated. */
const OPENAI_YAML = 'agents/openai.yaml';

/** List files recursively. */
function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() ? [path] : [];
  });
}

/** Remove the directories under `directory` that removing stale files left empty. */
function pruneEmpty(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    pruneEmpty(path);
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
  }
}

const skills = readdirSync(join(root, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, 'skills', entry.name, 'SKILL.md')))
  .map((entry) => entry.name);

for (const skill of skills) {
  const source = join(root, 'skills', skill);
  for (const path of files(source)) {
    generated.set(join(plugin, 'skills', skill, relative(source, path)), readFileSync(path));
  }
  const yaml = join(plugin, 'skills', skill, OPENAI_YAML);
  maintained.add(yaml);
  if (!existsSync(yaml)) {
    problems.push(`plugins/e2e/skills/${skill}/${OPENAI_YAML} is missing; write one by hand`);
  }
}

/** Serialize a manifest the way the committed files are formatted. */
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const versioned = { ...codexManifest, version: runner.version };
generated.set(join(plugin, '.codex-plugin/plugin.json'), json(versioned));
// Claude reads the same top-level fields; JSON.stringify drops Codex's `interface` block.
generated.set(join(plugin, '.claude-plugin/plugin.json'), json({ ...versioned, interface: undefined }));
// Cursor adds a display name and one logo.
generated.set(
  join(plugin, '.cursor-plugin/plugin.json'),
  json({
    ...versioned,
    interface: undefined,
    displayName: codexManifest.interface.displayName,
    logo: codexManifest.interface.logo,
  }),
);
generated.set(join(plugin, 'LICENSE'), readFileSync(join(root, 'LICENSE')));

const stale: string[] = [];
for (const path of files(join(plugin, 'skills'))) {
  if (generated.has(path) || maintained.has(path)) continue;
  stale.push(relative(root, path));
  if (!check) rmSync(path);
}
if (!check) pruneEmpty(join(plugin, 'skills'));
for (const [path, content] of generated) {
  if (existsSync(path) && readFileSync(path).equals(content)) continue;
  stale.push(relative(root, path));
  if (!check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

if (check && stale.length > 0) {
  problems.push(`Plugin files are out of date; run pnpm plugins:sync:\n${stale.join('\n')}`);
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`e2e plugin: ${check ? 'checked' : 'synced'} ${generated.size} generated files\n`);
}
