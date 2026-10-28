import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  REGISTRY_PATH,
  type Registry,
  type RegistryEnvironment,
  readEnvironment,
  readmeUrl,
  registryProblems,
  schemaProblems,
} from './examples-registry.ts';

const ENV: RegistryEnvironment = { folders: ['with-vite'], icons: ['vite.svg'], initExamples: ['with-vite'] };

function registry(examples: Record<string, unknown>[] = []): Registry {
  return {
    tags: {
      framework: [{ id: 'vite', label: 'Vite' }],
      useCase: [{ id: 'auth', label: 'Authentication' }],
      platform: [{ id: 'web', label: 'Web' }],
    },
    examples: [
      {
        slug: 'with-vite',
        icon: 'vite.svg',
        source: 'official',
        repository: 'https://github.com/tester-army/e2e/tree/main/examples/with-vite',
        tags: { framework: ['vite'], platform: ['web'] },
      },
      ...examples,
    ],
  } as unknown as Registry;
}

const community = {
  slug: 'vite-auth',
  source: 'community',
  repository: 'https://github.com/someone/vite-auth',
  author: { name: 'Someone', github: 'someone' },
  tags: { framework: ['vite'], useCase: ['auth'], platform: ['web'] },
};

describe('examples/examples.json', () => {
  it('matches the schema and the rules', () => {
    const json = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as unknown;
    assert.deepEqual(schemaProblems(json), []);
    assert.deepEqual(registryProblems(json as Registry, readEnvironment()), []);
  });
});

describe('schemaProblems', () => {
  it('rejects an example without a source and with an unknown field', () => {
    const { source: _, ...rest } = { ...community, title: 'Vite auth', description: 'd', author: { name: 'A', github: 'a' }, license: 'MIT' };
    const problems = schemaProblems({ ...registry(), examples: [{ ...rest, stars: 5 }] });
    assert.ok(problems.some((problem) => problem.includes("'source'")), problems.join('\n'));
    assert.ok(problems.some((problem) => problem.includes('stars')), problems.join('\n'));
  });
});

describe('schemaProblems on the slug', () => {
  it('rejects the slug the site uses for its share card route', () => {
    const json = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
    const [first] = json.examples;
    const problems = schemaProblems({ ...json, examples: [{ ...first, slug: 'opengraph-image' }] });
    assert.ok(problems.some((problem) => problem.startsWith('/examples/0/slug')), problems.join('\n'));
  });
});

describe('registryProblems', () => {
  it('accepts a community example in its own repository', () => {
    assert.deepEqual(registryProblems(registry([community]), ENV), []);
  });

  it('rejects a duplicate slug and an undefined tag', () => {
    const problems = registryProblems(
      registry([community, { ...community, tags: { framework: ['svelte'], platform: ['web'] } }]),
      ENV,
    );
    assert.deepEqual(problems, [
      'examples: slug "vite-auth" is used twice',
      'examples "vite-auth": tag "svelte" is not defined in tags.framework',
    ]);
  });

  it('keeps community examples out of the organization and official ones in it', () => {
    const problems = registryProblems(
      registry([
        { ...community, repository: 'https://github.com/tester-army/e2e/tree/main/examples/with-vite' },
        { ...community, slug: 'fake-official', source: 'official' },
      ]),
      ENV,
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /community example lives in its own repository/);
    assert.match(problems[1]!, /official example lives under https:\/\/github\.com\/tester-army\//);
  });

  it("accepts a partner example in its author's repository, and keeps it out of the organization", () => {
    const partner = { ...community, slug: 'smolmachines', source: 'partner' };
    assert.deepEqual(registryProblems(registry([partner]), ENV), []);
    const problems = registryProblems(
      registry([
        { ...partner, repository: 'https://github.com/tester-army/e2e-smolmachines' },
        { ...partner, slug: 'impostor', repository: 'https://github.com/someone-else/e2e-smolmachines' },
      ]),
      ENV,
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /"smolmachines": a partner example lives in its own repository, outside the tester-army organization/);
    assert.match(problems[1]!, /"impostor": a partner example lives in its author's repository, https:\/\/github\.com\/someone\//);
  });

  it('accepts an official example in its own tester-army repository, and no community one there', () => {
    const problems = registryProblems(
      registry([
        { ...community, slug: 'stripe', source: 'official', repository: 'https://github.com/tester-army/e2e-stripe' },
        { ...community, repository: 'https://github.com/tester-army/e2e-clerk' },
        { ...community, slug: 'loose', source: 'official', repository: 'https://github.com/tester-army/e2e/tree/main/docs' },
      ]),
      ENV,
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /"vite-auth": a community example lives in its own repository, outside the tester-army organization/);
    assert.match(problems[1]!, /"loose": an official example in tester-army\/e2e must point at its folder/);
  });

  it('requires an entry for every example folder and an icon file for every icon', () => {
    const problems = registryProblems(registry(), { ...ENV, folders: ['with-vite', 'with-svelte'], icons: [] });
    assert.deepEqual(problems, [
      'examples "with-vite": icon vite.svg is not in examples/icons/',
      'examples/with-svelte has no official entry in examples/examples.json',
    ]);
  });
});

describe('registryProblems on official folders and tags', () => {
  it('rejects an official folder the CLI cannot copy', () => {
    assert.deepEqual(registryProblems(registry(), { ...ENV, initExamples: [] }), [
      'examples "with-vite": e2e init --example cannot copy with-vite; add it to packages/e2e/src/cli/init/examples.ts',
    ]);
  });

  it('rejects an official folder whose slug is not the folder name', () => {
    const [vite] = registry().examples;
    const problems = registryProblems({ ...registry(), examples: [{ ...vite!, slug: 'vite' }] }, ENV);
    assert.deepEqual(problems, [
      'examples "vite": an official example\'s slug must be its folder name, with-vite',
      'examples/with-vite has no official entry in examples/examples.json',
    ]);
  });

  it('rejects a tag id defined twice', () => {
    const base = registry();
    const problems = registryProblems(
      { ...base, tags: { ...base.tags, platform: [...base.tags.platform, { id: 'web', label: 'Browser' }] } },
      ENV,
    );
    assert.deepEqual(problems, ['tags.platform: "web" is defined twice']);
  });
});

describe('readmeUrl', () => {
  it('reads the default branch of a bare repository and the folder of a tree URL', () => {
    assert.equal(readmeUrl('https://github.com/a/b'), 'https://raw.githubusercontent.com/a/b/HEAD/README.md');
    assert.equal(
      readmeUrl('https://github.com/a/b/tree/main/examples/x'),
      'https://raw.githubusercontent.com/a/b/main/examples/x/README.md',
    );
  });
});
