import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const output = process.argv[2];
if (!output) throw new Error('Supply an explicit output executable path; nothing is compiled on install');
const source = fileURLToPath(new URL('../native/', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'e2e-wayland-build-'));
try {
  for (const protocol of ['virtual-keyboard', 'virtual-pointer']) {
    execFileSync('wayland-scanner', ['client-header', join(source, protocol + '.xml'), join(directory, protocol + '-client.h')], { stdio: 'inherit' });
    execFileSync('wayland-scanner', ['private-code', join(source, protocol + '.xml'), join(directory, protocol + '-protocol.c')], { stdio: 'inherit' });
  }
  const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'wayland-client', 'xkbcommon'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  execFileSync(process.env.CC ?? 'cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-I' + directory, join(source, 'input.c'), join(directory, 'virtual-keyboard-protocol.c'), join(directory, 'virtual-pointer-protocol.c'), ...flags, '-o', resolve(output)], { stdio: 'inherit' });
} finally { rmSync(directory, { recursive: true }); }
