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
  repository: 'https://github.com/someone/vite-auth/tree/0123456789abcdef0123456789abcdef01234567',
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
    const partner = { ...community, slug: 'smolmachines', source: 'partner', author: { ...community.author, website: 'https://someone.dev' } };
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

  it('requires a landing page on a partner example, and allows it on no other', () => {
    const partner = { ...community, slug: 'smolmachines', source: 'partner' };
    const problems = registryProblems(
      registry([partner, { ...community, author: { ...community.author, website: 'https://someone.dev' } }]),
      ENV,
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /"smolmachines": a partner example names its author's landing page in author\.website/);
    assert.match(problems[1]!, /"vite-auth": only a partner example has author\.website/);
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

describe('registryProblems on community pins and readme', () => {
  const pinned = 'https://github.com/someone/vite-auth/tree/0123456789abcdef0123456789abcdef01234567/tests';

  it('rejects a community example on a branch', () => {
    const problems = registryProblems(registry([{ ...community, repository: 'https://github.com/someone/vite-auth/tree/main/tests' }]), ENV);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0]!, /"vite-auth": a community example pins its repository to a commit/);
  });

  it('accepts a readme file in the same repository, or none', () => {
    const problems = registryProblems(
      registry([
        { ...community, repository: pinned, readme: 'https://github.com/someone/vite-auth/blob/0123456789abcdef0123456789abcdef01234567/docs/e2e.md' },
        { ...community, slug: 'no-readme', repository: pinned, readme: false },
      ]),
      ENV,
    );
    assert.deepEqual(problems, []);
  });

  it("rejects a readme in another repository, and one that is the folder's own README", () => {
    const problems = registryProblems(
      registry([
        { ...community, repository: pinned, readme: 'https://github.com/someone-else/docs/blob/main/e2e.md' },
        { ...community, slug: 'own', repository: pinned, readme: 'https://github.com/someone/vite-auth/blob/0123456789abcdef0123456789abcdef01234567/tests/README.md' },
      ]),
      ENV,
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /"vite-auth": readme must be a file in the example's repository, https:\/\/github\.com\/someone\/vite-auth\//);
    assert.match(problems[1]!, /"own": readme names the folder's own README\.md; leave it out/);
  });
});

describe('registryProblems on a community readme', () => {
  it("rejects a readme on another ref than the repository's commit", () => {
    const problems = registryProblems(
      registry([
        {
          ...community,
          repository: 'https://github.com/someone/vite-auth/tree/0123456789abcdef0123456789abcdef01234567/tests',
          readme: 'https://github.com/someone/vite-auth/blob/main/docs/e2e.md',
        },
      ]),
      ENV,
    );
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0]!, /"vite-auth": a community example's readme is pinned to the same commit as its repository/);
  });
});

describe('schemaProblems on readme', () => {
  it('accepts a Markdown file on GitHub or false, and nothing else', () => {
    const json = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
    const [first] = json.examples;
    const withReadme = (readme: unknown) => schemaProblems({ ...json, examples: [{ ...first, readme }] });
    assert.deepEqual(withReadme('https://github.com/a/b/blob/main/docs/e2e.md'), []);
    assert.deepEqual(withReadme(false), []);
    for (const readme of [true, 'https://github.com/a/b/tree/main/docs', 'https://example.com/e2e.md']) {
      assert.ok(withReadme(readme).some((problem) => problem.startsWith('/examples/0/readme')), String(readme));
    }
  });
});

describe('readmeUrl', () => {
  it('reads the default branch of a bare repository and the folder of a tree URL', () => {
    assert.equal(readmeUrl({ repository: 'https://github.com/a/b' }), 'https://raw.githubusercontent.com/a/b/HEAD/README.md');
    assert.equal(
      readmeUrl({ repository: 'https://github.com/a/b/tree/main/examples/x' }),
      'https://raw.githubusercontent.com/a/b/main/examples/x/README.md',
    );
  });

  it('reads the readme file when one is named, and nothing for readme: false', () => {
    assert.equal(
      readmeUrl({ repository: 'https://github.com/a/b/tree/abc/tests', readme: 'https://github.com/a/b/blob/abc/docs/e2e.md' }),
      'https://raw.githubusercontent.com/a/b/abc/docs/e2e.md',
    );
    assert.equal(readmeUrl({ repository: 'https://github.com/a/b/tree/abc/tests', readme: false }), undefined);
  });
});
