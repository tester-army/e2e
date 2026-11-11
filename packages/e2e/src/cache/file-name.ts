import { readFile, stat, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../internal/ids.ts';
import { readReplayYaml } from './yaml.ts';

/** A readable ASCII basename with bounded length, including on Windows filesystems. */
export function cacheFileName(testId: string): string {
  const [source = '', ...titles] = testId.split('::');
  const stem = source.replaceAll('\\', '/').split('/').at(-1)!.replace(/(?:\.e2e)?\.[^.]+$/u, '');
  const title = titles.map((part) => { try { return decodeURIComponent(part); } catch { return part; } }).join(' ');
  const clean = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  const filePart = clean(stem), titlePart = clean(title);
  const combined = titlePart.startsWith(filePart + '-') || titlePart === filePart ? titlePart : [filePart, titlePart].filter(Boolean).join('-');
  // Include a boundary at character 40; only split a word when the first word alone exceeds the cap.
  const boundary = combined.lastIndexOf('-', 40);
  const slug = (combined.length <= 40 ? combined : combined.slice(0, boundary > 0 ? boundary : 40)) || 'test';
  return `${/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/u.test(slug) ? 'test-' : ''}${slug}.yml`;
}

/** Recognizes only our flat, safe YAML names; old caches and temporary files are ignored. */
export function isCacheFile(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,88}\.yml$/u.test(name);
}

/** The collision suffix is derived from identity, never collection or worker order. */
function disambiguated(testId: string, displayTestId: string): string {
  return cacheFileName(displayTestId).replace(/\.yml$/u, `--${sha256Hex(testId).slice(0, 12)}.yml`);
}

/** Reads only a bounded identity; malformed data stays available for normal invalid-entry handling. */
async function identity(file: string, testId?: string): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > 1_048_576) return undefined;
    const source = await readFile(file, 'utf8');
    if (Buffer.byteLength(source) > 1_048_576) return undefined;
    const recording = readReplayYaml(source, file);
    return recording.testId === testId && recording.id !== sha256Hex(testId) ? undefined : recording.id;
  } catch { return undefined; }
}

/** Finds this test without reading legacy formats or treating a colliding test as a cache hit. */
export async function resolveCacheFile(directory: string, testId: string, writing = false, displayTestId = testId): Promise<string> {
  const base = join(directory, cacheFileName(displayTestId));
  const suffix = join(directory, disambiguated(testId, displayTestId));
  const id = sha256Hex(testId);
  // Provider secrets may redact a title only after the first live fill. Identity remains stable.
  let relocated: string | undefined;
  const locateElsewhere = async (): Promise<string | undefined> => {
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (!isCacheFile(name)) continue;
      const file = join(directory, name);
      if (file !== base && file !== suffix && await identity(file) === id) {
        if (relocated !== undefined) throw new Error('duplicate recording identity in cache folder');
        relocated = file;
      }
    }
    return relocated;
  };
  const finish = async (file: string): Promise<string> => {
    if (writing && relocated !== undefined && relocated !== file) await rename(relocated, file);
    return file;
  };
  const suffixedId = await identity(suffix, testId);
  if (suffixedId === id) return suffix;
  if (suffixedId !== undefined) throw new Error(`cache filename digest collision: ${suffix}`);
  const baseId = await identity(base, testId);
  if (baseId !== id && await locateElsewhere() !== undefined && !writing) return relocated!;
  if (baseId === undefined || baseId === id) {
    // An invalid suffixed file must remain an invalid hit, rather than silently running live in strict mode.
    if (await stat(suffix).then(() => true, () => false)) return suffix;
    if (baseId === undefined) {
      const prefix = cacheFileName(displayTestId).slice(0, -4) + '--';
      const family = (await readdir(directory).catch(() => [] as string[])).some((name) => name.startsWith(prefix) && /^[a-f0-9]{12}\.yml$/u.test(name.slice(prefix.length)));
      if (family) return finish(suffix);
    }
    return finish(base);
  }
  if (writing) {
    const other = base.replace(/\.yml$/u, `--${baseId.slice(0, 12)}.yml`);
    if (other === suffix) throw new Error(`cache filename digest collision: ${suffix}`);
    const otherId = await identity(other);
    if (otherId !== undefined && otherId !== baseId) throw new Error(`cache filename digest collision: ${other}`);
    await rename(base, other);
  }
  return finish(suffix);
}
