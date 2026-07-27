/** Collection realm: imports test modules and derives stable identities. */

import path from 'node:path';
import { discoverFiles } from '../internal/globs.ts';
import { CollectionError } from '../internal/errors.ts';
import { setupTestId, testId } from '../internal/ids.ts';
import { importModule } from '../config/load.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import {
  collectModule,
  groupTitles,
  outermostSerialGroup,
  type GroupNode,
  type ModuleRegistration,
  type RegisteredTest,
  type SourceLocation,
} from './registry.ts';

/**
 * Everything needed to name and report a test, with no executable or realm
 * state attached. Fully JSON-serializable, so it is what result records carry
 * and what crosses the runner<->worker IPC channel.
 */
export interface TestIdentity {
  readonly kind: 'test' | 'setup';
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly declarationIndex: number;
  readonly sessions: readonly string[];
  readonly source: SourceLocation | undefined;
  /** Normalized project-root-relative file path with `/` separators. */
  readonly file: string;
  readonly id: string;
  readonly serialId: string | undefined;
}

export interface CollectedTest extends RegisteredTest, TestIdentity {
  /** Outermost serial group, when the test is a serial-group member. */
  readonly serialRoot: GroupNode | undefined;
}

/** Narrows a collected test to its reportable, serializable identity. */
export function testIdentity(test: CollectedTest): TestIdentity {
  return {
    kind: test.kind,
    title: test.title,
    titlePath: test.titlePath,
    declarationIndex: test.declarationIndex,
    sessions: test.sessions,
    source: test.source,
    file: test.file,
    id: test.id,
    serialId: test.serialId,
  };
}

export interface CollectedFile {
  readonly file: string;
  readonly absolutePath: string;
  readonly registration: ModuleRegistration;
  readonly tests: readonly CollectedTest[];
}

export interface Collection {
  readonly files: readonly CollectedFile[];
  readonly tests: readonly CollectedTest[];
}

/** Derives the serial unit source ID per 11-lifecycle.md. */
export function serialSourceId(file: string, group: GroupNode): string {
  return `serial::${testId(file, groupTitles(group))}`;
}

function toCollectedTests(file: string, registration: ModuleRegistration): CollectedTest[] {
  const seenTitlePaths = new Set<string>();
  return registration.tests.map((registered) => {
    const encoded = testId(file, registered.titlePath);
    if (seenTitlePaths.has(encoded)) {
      throw new CollectionError(
        `duplicate title path ${registered.titlePath.join(' > ')} in ${file}`,
      );
    }
    seenTitlePaths.add(encoded);
    const serialRoot = outermostSerialGroup(registered.group);
    return {
      ...registered,
      file,
      id: registered.kind === 'setup' ? setupTestId(file, registered.titlePath) : encoded,
      serialRoot,
      serialId: serialRoot === undefined ? undefined : serialSourceId(file, serialRoot),
    };
  });
}

/** Normalizes an absolute or relative file path to the project-root-relative wire form. */
export function normalizeRelativePath(projectRoot: string, filePath: string): string {
  const relative = path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : filePath;
  const normalized = relative.split(path.sep).join('/');
  if (normalized.startsWith('..')) {
    throw new CollectionError(`test file is outside the project root: ${filePath}`);
  }
  return normalized;
}

/** Builds one CollectedFile from an already-produced registration. */
export function collectFromRegistration(
  projectRoot: string,
  filePath: string,
  registration: ModuleRegistration,
): CollectedFile {
  const file = normalizeRelativePath(projectRoot, filePath);
  return {
    file,
    absolutePath: path.resolve(projectRoot, file),
    registration,
    tests: toCollectedTests(file, registration),
  };
}

/**
 * Runs collection: resolves globs, sorts matched files by code point, and
 * imports each module once in the collection realm.
 */
export async function collect(
  config: ResolvedConfig,
  fileFilter?: readonly string[],
): Promise<Collection> {
  let matched = discoverFiles(config.projectRoot, config.tests);
  if (fileFilter !== undefined && fileFilter.length > 0) {
    const normalizedFilters = new Set(fileFilter.map((file) => normalizeRelativePath(config.projectRoot, file)));
    matched = matched.filter((file) => normalizedFilters.has(file));
  }
  const files: CollectedFile[] = [];
  for (const file of matched) {
    const absolutePath = path.join(config.projectRoot, file);
    let registration: ModuleRegistration;
    try {
      registration = await collectModule(() => importModule(absolutePath, 'collect'));
    } catch (cause) {
      if (cause instanceof CollectionError) throw cause;
      throw new CollectionError(
        `failed to collect ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    files.push(collectFromRegistration(config.projectRoot, absolutePath, registration));
  }
  return { files, tests: files.flatMap((file) => file.tests) };
}
