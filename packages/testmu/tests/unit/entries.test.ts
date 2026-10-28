/**
 * Each entry imports only its own engine, at runtime and in its types, so a
 * project with one engine installed loads and type-checks the entry it uses:
 * the root never reaches `@e2e-dev/web`, and `./web` never reaches
 * `@e2e-dev/mobile` or agent-device.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const SRC = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'src');

/** Every package an entry imports, following its relative imports through `src`. */
function packagesImportedBy(entry: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const pending = [path.join(SRC, entry)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      if (specifier === undefined) continue;
      if (specifier.startsWith('.')) pending.push(path.resolve(path.dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return packages;
}

it('keeps the root entry off @e2e-dev/web', () => {
  const imported = packagesImportedBy('index.ts');

  expect(imported).toContain('@e2e-dev/mobile');
  expect(imported).not.toContain('@e2e-dev/web');
});

it('keeps the ./web entry off @e2e-dev/mobile and agent-device', () => {
  const imported = packagesImportedBy('web.ts');

  expect(imported).toContain('@e2e-dev/web');
  expect([...imported].filter((name) => name === '@e2e-dev/mobile' || name.includes('agent-device'))).toEqual([]);
});
