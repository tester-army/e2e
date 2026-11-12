const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const version = process.env.AGENT_DEVICE_VERSION;
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Expected an exact agent-device version, got ${version}`);
}
const [mode, manager = 'pnpm'] = process.argv.slice(2);
if (mode === 'override') {
  if (manager === 'pnpm') {
    const path = 'pnpm-workspace.yaml';
    const yaml = fs.readFileSync(path, 'utf8');
    if (!/^overrides:$/m.test(yaml)) throw new Error('Missing workspace overrides');
    fs.writeFileSync(path, yaml.replace(/^overrides:$/m, `overrides:\n  agent-device: '${version}'`));
  } else {
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    manifest.overrides = { ...manifest.overrides, 'agent-device': version };
    fs.writeFileSync('package.json', `${JSON.stringify(manifest, null, 2)}\n`);
  }
} else if (mode === 'verify') {
  const args = manager === 'pnpm' ? ['list', '-r', '--depth', 'Infinity', '--json'] : ['ls', 'agent-device', '--all', '--json'];
  const graph = JSON.parse(execFileSync(manager, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  let count = 0;
  /** Checks every occurrence, including nested copies and workspace links. */
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'agent-device') {
        if (child.version !== version) throw new Error(`agent-device resolved to ${child.version}, expected ${version}`);
        count++;
      }
      visit(child);
    }
  }
  visit(graph);
  // Web-only standalone examples do not install the mobile engine.
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const expectsDriver = manager === 'pnpm' || manifest.dependencies?.['@e2e-dev/mobile'] || manifest.devDependencies?.['@e2e-dev/mobile'];
  if (!count && expectsDriver) throw new Error('No installed agent-device found');
  const message = `agent-device ${version}: verified ${count} dependency graph entries`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
