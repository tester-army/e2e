import { readFile, writeFile } from 'node:fs/promises';
import { emitTest } from '../../packages/e2e/scripts/code-cache-emit.ts';

const [input, output, title = 'recorded flow'] = process.argv.slice(2);
if (input === undefined || output === undefined) throw new Error('Usage: node scripts/code-cache/export.ts input.json output.e2e.ts [title]');
const source = emitTest(JSON.parse(await readFile(input, 'utf8')), title);
await writeFile(output, source, { flag: 'wx' });
