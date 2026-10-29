/**
 * The examples registry, `examples/examples.json`: every example on
 * https://e2e.tester.army/examples, official, partner, and community. The site
 * (tester-army/e2e-site) downloads the file at build time and renders a page
 * per entry from it and the README at its `repository` (or its `readme`);
 * `site.yml` redeploys
 * the site when the file changes on `main`.
 *
 * `examples.schema.json` pins the shape; `registryProblems` checks what a
 * schema cannot: unique slugs and tags, tags an example names but the
 * registry does not define, icons that are not in `examples/icons/`, official
 * examples living under the tester-army organization (and, in this
 * repository, matching the folders under `examples/` and the ones
 * `e2e init --example` can copy), partner and community examples living
 * outside it, partner examples in their author's own repository, community
 * examples pinned to a commit, and a `readme` only where the folder has no
 * README.md, in the example's own repository.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { REPO_ROOT } from './public-packages.ts';

const EXAMPLES_DIR = join(REPO_ROOT, 'examples');
export const REGISTRY_PATH = join(EXAMPLES_DIR, 'examples.json');
const SCHEMA_PATH = join(EXAMPLES_DIR, 'examples.schema.json');
const ICONS_DIR = join(EXAMPLES_DIR, 'icons');
/**
 * The `e2e init --example` presets, read as text: the module uses syntax
 * Node's type stripping cannot run (parameter properties).
 */
const INIT_EXAMPLES_PATH = join(REPO_ROOT, 'packages/e2e/src/cli/init/examples.ts');

/** An official example in this repository: its folder under `examples/` on `main`. */
const FOLDER_URL = /^https:\/\/github\.com\/tester-army\/e2e\/tree\/main\/examples\/([a-z0-9-]+)$/;
/** Any URL into this repository. */
const THIS_REPO_URL = /^https:\/\/github\.com\/tester-army\/e2e(?:\/|$)/i;
/** Any URL into the tester-army organization: official examples live there, and only they do. */
const ORG_URL = /^https:\/\/github\.com\/tester-army\//i;
function ownerOf(repository: string): string | undefined {
  return repository.match(/^https:\/\/github\.com\/([^/]+)\//)?.[1]?.toLowerCase();
}
/** `owner/repo` of a github.com URL, lowercased. */
function repoOf(url: string): string | undefined {
  return url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)/)?.[1]?.toLowerCase();
}
/** The ref of a `/tree/<ref>` or `/blob/<ref>` URL. */
function refOf(url: string): string | undefined {
  return url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:tree|blob)\/([^/]+)/)?.[1];
}
/** A folder URL whose ref is a full commit SHA. */
const PINNED_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[0-9a-f]{40}(?:\/|$)/;

/** Folders under `examples/` that are not examples: the site's logos. */
const UNLISTED_FOLDERS = new Set(['icons']);

export type TagKind = 'framework' | 'useCase' | 'platform';
const TAG_KINDS: readonly TagKind[] = ['framework', 'useCase', 'platform'];

interface Tag {
  id: string;
  label: string;
}

interface RegistryExample {
  slug: string;
  icon?: string;
  source: 'official' | 'partner' | 'community';
  repository: string;
  readme?: string | false;
  author: { github: string; website?: string };
  tags: Partial<Record<TagKind, string[]>>;
}

export interface Registry {
  tags: Record<TagKind, Tag[]>;
  examples: RegistryExample[];
}

export interface RegistryEnvironment {
  /** The folders under `examples/` that git tracks. */
  folders: string[];
  /** The file names in `examples/icons/`. */
  icons: string[];
  /** The folders `e2e init --example` can copy. */
  initExamples: string[];
}

export function readEnvironment(): RegistryEnvironment {
  return {
    // Tracked folders only: a renamed example leaves an untracked folder (its
    // ignored node_modules) behind on disk, which must not count as an example.
    folders: [
      ...new Set(
        execFileSync('git', ['ls-files', '-z', '--', 'examples/'], { cwd: REPO_ROOT, encoding: 'utf8' })
          .split('\0')
          .map((file) => file.split('/'))
          .filter((parts) => parts.length > 2)
          .map((parts) => parts[1]!),
      ),
    ],
    icons: existsSync(ICONS_DIR) ? readdirSync(ICONS_DIR) : [],
    initExamples: [...readFileSync(INIT_EXAMPLES_PATH, 'utf8').matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((match) => match[1]!),
  };
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/** The schema violations, as `<path>: <message>` lines. */
export function schemaProblems(json: unknown): string[] {
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>);
  if (validate(json)) return [];
  return (validate.errors ?? []).map((error) => {
    const extra = error.keyword === 'additionalProperties' ? ` (${String(error.params.additionalProperty)})` : '';
    return `${error.instancePath || '/'}: ${error.message ?? 'is invalid'}${extra}`;
  });
}

/** Everything wrong with a registry that already matches the schema; empty when it is fine. */
export function registryProblems(registry: Registry, env: RegistryEnvironment): string[] {
  const problems: string[] = [];

  for (const kind of TAG_KINDS) {
    for (const id of duplicates(registry.tags[kind].map((tag) => tag.id))) {
      problems.push(`tags.${kind}: "${id}" is defined twice`);
    }
  }

  for (const slug of duplicates(registry.examples.map((example) => example.slug))) {
    problems.push(`examples: slug "${slug}" is used twice`);
  }

  for (const example of registry.examples) {
    const name = `examples "${example.slug}"`;
    if (example.icon && !env.icons.includes(example.icon)) {
      problems.push(`${name}: icon ${example.icon} is not in examples/icons/`);
    }
    for (const kind of TAG_KINDS) {
      const known = new Set(registry.tags[kind].map((tag) => tag.id));
      for (const id of example.tags[kind] ?? []) {
        if (!known.has(id)) problems.push(`${name}: tag "${id}" is not defined in tags.${kind}`);
      }
    }

    const folder = example.repository.match(FOLDER_URL)?.[1];
    if (example.source === 'official') {
      if (!ORG_URL.test(example.repository)) {
        problems.push(`${name}: an official example lives under https://github.com/tester-army/`);
      } else if (THIS_REPO_URL.test(example.repository)) {
        // In this repository, an official example is one of the folders under examples/.
        if (!folder) {
          problems.push(`${name}: an official example in tester-army/e2e must point at its folder, https://github.com/tester-army/e2e/tree/main/examples/<folder>`);
        } else if (!env.folders.includes(folder)) {
          problems.push(`${name}: examples/${folder} does not exist`);
        } else if (folder !== example.slug) {
          problems.push(`${name}: an official example's slug must be its folder name, ${folder}`);
        } else if (!env.initExamples.includes(folder)) {
          problems.push(`${name}: e2e init --example cannot copy ${folder}; add it to packages/e2e/src/cli/init/examples.ts`);
        }
      }
    } else if (ORG_URL.test(example.repository)) {
      problems.push(`${name}: a ${example.source} example lives in its own repository, outside the tester-army organization`);
    } else if (example.source === 'partner' && ownerOf(example.repository) !== example.author.github.toLowerCase()) {
      // The site's partner seal credits author.name, so the partner must own the repository.
      problems.push(`${name}: a partner example lives in its author's repository, https://github.com/${example.author.github}/`);
    } else if (example.source === 'community' && !PINNED_URL.test(example.repository)) {
      // The page renders the README live: a branch could change under a reviewed entry.
      problems.push(`${name}: a community example pins its repository to a commit, https://github.com/<owner>/<repo>/tree/<commit sha>/<path>`);
    }
    if (typeof example.readme === 'string') {
      if (repoOf(example.readme) !== repoOf(example.repository)) {
        problems.push(`${name}: readme must be a file in the example's repository, https://github.com/${repoOf(example.repository)}/`);
      } else if (readmeUrl({ repository: example.repository, readme: example.readme }) === readmeUrl({ repository: example.repository })) {
        problems.push(`${name}: readme names the folder's own README.md; leave it out`);
      } else if (example.source === 'community' && refOf(example.readme) !== refOf(example.repository)) {
        problems.push(`${name}: a community example's readme is pinned to the same commit as its repository`);
      }
    }
    if (example.source === 'partner' && !example.author?.website) {
      problems.push(`${name}: a partner example names its author's landing page in author.website`);
    } else if (example.source !== 'partner' && example.author?.website) {
      // A website link is part of a partnership, not something any entry can add.
      problems.push(`${name}: only a partner example has author.website`);
    }
  }

  const listed = new Set(registry.examples.filter((example) => example.source === 'official').map((example) => example.slug));
  for (const folder of env.folders) {
    if (!UNLISTED_FOLDERS.has(folder) && !listed.has(folder)) {
      problems.push(`examples/${folder} has no official entry in examples/examples.json`);
    }
  }

  return problems;
}

/** Whether an example is a folder in this repository, which the checks read from disk instead of fetching. */
export function isLocalFolder(repository: string): boolean {
  return FOLDER_URL.test(repository);
}

/**
 * The raw URL of the README the site renders as an example's page: its
 * `readme` file when it names one, else README.md in its `repository`.
 * `undefined` for an example with `readme: false`.
 */
export function readmeUrl(example: Pick<RegistryExample, 'repository' | 'readme'>): string | undefined {
  if (example.readme === false) return undefined;
  if (example.readme) {
    const [, owner, repo, ref, path] = example.readme.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/) ?? [];
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  }
  const [, owner, repo, ref = 'HEAD', path = ''] =
    example.repository.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?$/) ?? [];
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path ? `${path}/` : ''}README.md`;
}
