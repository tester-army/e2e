/**
 * The ground truth a classifier compares a failure with, fetched only when
 * asked. A run never resolves a ref: the summary carries the pointers, and
 * `e2e-cige refs <id>` runs the config's resolvers for one case and writes
 * what they return to `<output>/cige/<id>.refs/`, where the classifying
 * agent reads it. A resolver that fails is recorded with its message, so one
 * unreachable wiki does not hide the release notes.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { fillRef, type CigeRef, type CigeRefs } from './config.ts';
import type { CigeCase } from './schema.ts';

const KINDS = ['spec', 'build', 'expected'] as const;

type RefKind = (typeof KINDS)[number];

/** One resolved ref as `index.json` lists it. `text` names the file its text went to. */
interface RefEntry {
  readonly pointer?: string;
  readonly url?: string;
  readonly files?: readonly string[];
  readonly text?: string;
  readonly error?: string;
}

/** The `index.json` of one case's refs. */
export interface CigeRefsIndex {
  readonly testId: string;
  readonly variant?: string;
  readonly build?: string;
  readonly environment?: string;
  readonly refs: Readonly<Partial<Record<RefKind, RefEntry>>>;
}

/** A case id or summary name as one safe path component. */
export function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** The directory one case's refs go to, beside its run summary. */
function refsDirectory(outputDir: string, testCase: CigeCase): string {
  const name = testCase.variant === undefined ? testCase.id : `${testCase.id}.${testCase.variant}`;
  return path.join(outputDir, `${fileSafe(name)}.refs`);
}

function pointerOf(testCase: CigeCase, kind: RefKind): string | undefined {
  if (kind === 'spec') return testCase.context.specRef;
  if (kind === 'build') return testCase.context.buildRef;
  return testCase.context.expectedRef;
}

function entryOf(pointer: string | undefined, found: CigeRef | undefined, textFile: string | undefined): RefEntry {
  return {
    ...(pointer === undefined ? {} : { pointer }),
    ...(found?.url === undefined ? {} : { url: found.url }),
    ...(found?.files === undefined ? {} : { files: found.files }),
    ...(textFile === undefined ? {} : { text: textFile }),
  };
}

/**
 * Resolves one case's refs and writes them: `index.json`, plus
 * `spec.md`, `build.md`, or `expected.md` for each resolver that returned
 * text. Replaces whatever an earlier call wrote for the case.
 */
export async function writeRefs(
  testCase: CigeCase,
  options: { readonly outputDir: string; readonly refs?: CigeRefs; readonly build?: string | undefined },
): Promise<{ readonly directory: string; readonly index: CigeRefsIndex }> {
  const environment = testCase.context.environment;
  const directory = refsDirectory(options.outputDir, testCase);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const refs: Partial<Record<RefKind, RefEntry>> = {};
  for (const kind of KINDS) {
    const pointer = fillRef(pointerOf(testCase, kind), { build: options.build, environment });
    const resolver = options.refs?.[kind];
    if (resolver === undefined) {
      if (pointer !== undefined) refs[kind] = { pointer };
      continue;
    }
    try {
      const found = await resolver({ testCase, build: options.build, environment, pointer });
      let textFile: string | undefined;
      if (found?.text !== undefined) {
        textFile = `${kind}.md`;
        writeFileSync(path.join(directory, textFile), found.text.endsWith('\n') ? found.text : `${found.text}\n`);
      }
      refs[kind] = entryOf(pointer, found, textFile);
    } catch (cause) {
      refs[kind] = { ...(pointer === undefined ? {} : { pointer }), error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  const index: CigeRefsIndex = {
    testId: testCase.id,
    ...(testCase.variant === undefined ? {} : { variant: testCase.variant }),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(environment === undefined ? {} : { environment }),
    refs,
  };
  writeFileSync(path.join(directory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return { directory, index };
}
