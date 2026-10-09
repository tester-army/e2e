/** Portable Vista galleries and paired images for humans and coding agents. */

import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodePng, encodePng, type RgbaImage } from '../internal/image.ts';
import { readVistas, type VistaCapture, type VistaIdentity } from './vista-report.ts';

interface VistaSide {
  target: string;
  attempt: number;
  attemptStatus: string;
  carried: boolean;
  image?: string;
  width?: number;
  height?: number;
  unavailable?: string;
}

interface VistaPair {
  identity: VistaIdentity;
  status: 'identical' | 'changed' | 'unavailable';
  before?: VistaSide;
  after?: VistaSide;
  paired?: string;
}

/** Path containment also rejects a symlink pointing outside the saved artifacts. */
async function artifactPath(directory: string, relative: string): Promise<string> {
  const root = await realpath(path.join(directory, 'results'));
  const file = await realpath(path.resolve(root, relative));
  const fromRoot = path.relative(root, file);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error('Screenshot path is outside the saved run results');
  }
  return file;
}

/** Copies a decoded PNG so the gallery remains usable after either run is removed. */
async function copyCapture(directory: string, capture: VistaCapture | undefined, output: string, name: string):
Promise<{ side: VistaSide; pixels?: RgbaImage } | undefined> {
  if (capture === undefined) return undefined;
  const side: VistaSide = { target: capture.identity.target, attempt: capture.attempt, attemptStatus: capture.attemptStatus, carried: capture.carried };
  if (capture.path === undefined) return { side: { ...side, unavailable: capture.unavailable ?? 'No screenshot' } };
  let pixels: RgbaImage;
  try {
    pixels = decodePng(await readFile(await artifactPath(directory, capture.path)));
  } catch {
    return { side: { ...side, unavailable: 'Screenshot missing, outside results, or not a readable PNG' } };
  }
  await writeFile(path.join(output, name), encodePng(pixels));
  return { side: { ...side, image: name, width: pixels.width, height: pixels.height }, pixels };
}

/** Left is original, right is rewrite; dimensions remain unscaled, separated by a neutral gutter. */
function pairedImage(before: RgbaImage, after: RgbaImage): RgbaImage {
  const width = before.width + after.width + 24;
  const height = Math.max(before.height, after.height);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 232;
    data[i + 1] = 235;
    data[i + 2] = 239;
    data[i + 3] = 255;
  }
  for (const [image, offset] of [[before, 0], [after, before.width + 24]] as const) {
    for (let row = 0; row < image.height; row += 1) {
      data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), (row * width + offset) * 4);
    }
  }
  return { width, height, data };
}

/** Context-safe HTML text and attribute values; report labels never become markup or file names. */
function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** A standalone gallery that works from disk, with no network resources. */
function gallery(pairs: readonly VistaPair[]): string {
  const cards = pairs.map((pair) => {
    const { identity } = pair;
    const sides = (['before', 'after'] as const).map((name) => {
      const side = pair[name];
      return `<figure><figcaption>${name === 'before' ? 'Original' : 'Rewrite'}${side === undefined ? '' : ` · ${html(side.target)} · attempt ${side.attempt} (${html(side.attemptStatus)})${side.carried ? ' · carried from an earlier run' : ''}`}</figcaption>${side?.image === undefined ? `<p class="missing">${html(side?.unavailable ?? 'Checkpoint absent')}</p>` : `<a href="${html(side.image)}"><img loading="lazy" src="${html(side.image)}" alt="${name}: ${html(identity.name)}"><span>${side.width} × ${side.height}</span></a>`}</figure>`;
    }).join('');
    return `<article><h2>${html(identity.name)} <small>${pair.status}</small></h2><p>${html(identity.file)} › ${identity.titlePath.map(html).join(' › ')} · ${html(identity.target)} / ${html(identity.platform)} · agent ${html(identity.agent)} · repeat ${identity.repeat + 1} · occurrence ${identity.occurrence}</p><div class="pair">${sides}</div>${pair.paired === undefined ? '' : `<p><a href="${html(pair.paired)}">Open paired PNG (original left, rewrite right)</a></p>`}</article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"><title>Vista comparison</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f1f4f8;color:#182334}header,main{max-width:1600px;margin:auto;padding:24px}h1{font-size:32px;margin:0}h2{margin:0;font-size:20px}p{overflow-wrap:anywhere}header p{margin-bottom:0}article{background:white;padding:24px;margin-bottom:24px;border:1px solid #d5dde8;border-radius:12px}small{font-size:12px;background:#e9eef5;border-radius:16px;padding:4px 10px;margin-left:8px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}figure{margin:0;min-width:0}figcaption{font-weight:600;margin-bottom:12px}img{display:block;max-width:100%;height:auto;border:1px solid #ccd5e1;box-sizing:border-box}a{color:#2559a8}figure a{display:block}span{display:block;font-size:12px}.missing{padding:48px 16px;background:#fff3da}article>p{color:#596679}
</style></head><body><header><h1>Vista</h1><p>${pairs.length} named checkpoints · original on the left, rewrite on the right. Pixel equality is not a visual approval.</p><p><a href="index.json">Agent index (JSON)</a></p></header><main>${cards}</main></body></html>`;
}

/** Creates a new comparison directory; existing output is never overwritten. */
export async function vista(before: string, after: string, options: {
  output: string; beforeTarget?: string; afterTarget?: string;
}): Promise<{ count: number; unavailable: number; output: string }> {
  if ((options.beforeTarget === undefined) !== (options.afterTarget === undefined)) {
    throw new Error('Vista: --before-target and --after-target must be supplied together');
  }
  const original = await readVistas(before, options.beforeTarget);
  const rewrite = await readVistas(after, options.afterTarget);
  const remap = options.beforeTarget !== undefined;
  /** Explicit target selection lets differently named targets share the same identity. */
  const key = (capture: VistaCapture): string => JSON.stringify({ ...capture.identity, target: remap ? '' : capture.identity.target });
  /** Ambiguous identities must not silently overwrite a checkpoint. */
  const index = (captures: VistaCapture[]): Map<string, VistaCapture> => {
    const entries = new Map<string, VistaCapture>();
    for (const capture of captures) {
      const id = key(capture);
      if (entries.has(id)) throw new Error(`Vista: ambiguous checkpoint identity ${id}`);
      entries.set(id, capture);
    }
    return entries;
  };
  const left = index(original.captures);
  const right = index(rewrite.captures);
  const keys = [...new Set([...left.keys(), ...right.keys()])].toSorted();
  if (keys.length === 0) throw new Error('Vista: no app.vista() checkpoints found in either saved run');
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const pairs: VistaPair[] = [];
  try {
    for (const [i, id] of keys.entries()) {
      const name = String(i + 1).padStart(4, '0');
      const a = await copyCapture(before, left.get(id), output, `${name}-before.png`);
      const b = await copyCapture(after, right.get(id), output, `${name}-after.png`);
      const pair: VistaPair = {
        identity: (left.get(id) ?? right.get(id))!.identity, status: 'unavailable',
        ...(a === undefined ? {} : { before: a.side }), ...(b === undefined ? {} : { after: b.side }),
      };
      if (a?.pixels !== undefined && b?.pixels !== undefined) {
        pair.status = a.pixels.width === b.pixels.width && a.pixels.height === b.pixels.height &&
          Buffer.from(a.pixels.data).equals(Buffer.from(b.pixels.data)) ? 'identical' : 'changed';
        pair.paired = `${name}-paired.png`;
        await writeFile(path.join(output, pair.paired), encodePng(pairedImage(a.pixels, b.pixels)));
      }
      pairs.push(pair);
    }
    await writeFile(path.join(output, 'index.json'), JSON.stringify({ schemaVersion: 'vista-1', beforeRun: original.runId, afterRun: rewrite.runId, pairs }, null, 2));
    await writeFile(path.join(output, 'index.html'), gallery(pairs));
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw cause;
  }
  return { count: pairs.length, unavailable: pairs.filter((pair) => pair.status === 'unavailable').length, output: path.join(output, 'index.html') };
}
