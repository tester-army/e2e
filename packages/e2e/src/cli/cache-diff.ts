import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';

/** Shows current changes against Git's index without retaining old recording values in sidecars. */
export async function cacheDiff(directory: string): Promise<string> {
  const git = promisify(execFile);
  const { stdout } = await git('git', ['-C', directory, '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--', '.'], { maxBuffer: 4 * 1_048_576, env: { ...process.env, GIT_PAGER: 'cat' } });
  return stripVTControlCharacters(stdout);
}
