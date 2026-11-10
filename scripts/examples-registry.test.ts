import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  REGISTRY_PATH,
  type Registry,
  type RegistryEnvironment,
  readEnvironment,
  isLocalFolder,
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
        repository: 'https://github.com/e2e-inc/e2e/tree/main/examples/with-vite',
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

  for (const owner of ['e2e-inc', 'tester-army']) {
    it(`recognizes official folders and repositories under ${owner}`, () => {
      const base = registry();
      base.examples[0]!.repository = `https://github.com/${owner}/e2e/tree/main/examples/with-vite`;
      assert.equal(isLocalFolder(base.examples[0]!.repository), true);
      assert.deepEqual(registryProblems(base, ENV), []);
      assert.deepEqual(registryProblems(registry([
        { ...community, source: 'official', repository: `https://github.com/${owner}/e2e-clerk` },
      ]), ENV), []);
      const problems = registryProblems(registry([
        { ...community, source: 'official', repository: `https://github.com/${owner}/e2e/tree/main/docs` },
        { ...community, slug: 'community', repository: `https://github.com/${owner}/e2e-clerk` },
        { ...community, slug: 'partner', source: 'partner', repository: `https://github.com/${owner}/e2e-partner`, author: { github: owner, website: 'https://example.com' } },
      ]), ENV);
      assert.equal(problems.length, 3);
      assert.match(problems[0]!, /must point at its folder/);
      assert.match(problems[1]!, /outside the e2e-inc organization/);
      assert.match(problems[2]!, /outside the e2e-inc organization/);
      assert.equal(isLocalFolder(`https://github.com/${owner}-other/e2e/tree/main/examples/with-vite`), false);
      assert.equal(readmeUrl({ repository: base.examples[0]!.repository }), `https://raw.githubusercontent.com/${owner}/e2e/main/examples/with-vite/README.md`);
    });
  }

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
        { ...community, repository: 'https://github.com/e2e-inc/e2e/tree/main/examples/with-vite' },
        { ...community, slug: 'fake-official', source: 'official' },
      ]),
      ENV,
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /community example lives in its own repository/);
    assert.match(problems[1]!, /official example lives under https:\/\/github\.com\/e2e-inc\//);
  });

  it("accepts a partner example in its author's repository, and keeps it out of the organization", () => {
    const partner = { ...community, slug: 'smolmachines', source: 'partner', author: { ...community.author, website: 'https://someone.dev' } };
    assert.deepEqual(registryProblems(registry([partner]), ENV), []);
    const problems = registryProblems(
      registry([
        { ...partner, repository: 'https://github.com/e2e-inc/e2e-smolmachines' },
        { ...partner, slug: 'impostor', repository: 'https://github.com/someone-else/e2e-smolmachines' },
      ]),
      ENV,
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /"smolmachines": a partner example lives in its own repository, outside the e2e-inc organization/);
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

  it('accepts an official example in its own e2e-inc repository, and no community one there', () => {
    const problems = registryProblems(
      registry([
        { ...community, slug: 'stripe', source: 'official', repository: 'https://github.com/e2e-inc/e2e-stripe' },
        { ...community, repository: 'https://github.com/e2e-inc/e2e-clerk' },
        { ...community, slug: 'loose', source: 'official', repository: 'https://github.com/e2e-inc/e2e/tree/main/docs' },
      ]),
      ENV,
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /"vite-auth": a community example lives in its own repository, outside the e2e-inc organization/);
    assert.match(problems[1]!, /"loose": an official example in e2e-inc\/e2e must point at its folder/);
  });

  it('accepts an official example in the e2e_inc group on GitLab, and no community or partner one there', () => {
    const partner = { ...community, slug: 'partner', source: 'partner', author: { ...community.author, website: 'https://someone.dev' } };
    const problems = registryProblems(
      registry([
        { ...community, slug: 'gitlab-ci', source: 'official', repository: 'https://gitlab.com/e2e_inc/e2e-gitlab-ci' },
        { ...community, repository: 'https://gitlab.com/e2e_inc/e2e-gitlab-ci/-/tree/0123456789abcdef0123456789abcdef01234567' },
        { ...partner, repository: 'https://gitlab.com/someone/e2e-partner' },
        { ...community, slug: 'elsewhere', source: 'official', repository: 'https://gitlab.com/someone/e2e-gitlab-ci' },
      ]),
      ENV,
    );
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.match(problems[0]!, /"vite-auth": a community example lives in its own repository, outside the e2e-inc organization and the e2e_inc group/);
    assert.match(problems[1]!, /"partner": a partner example lives in its author's repository, https:\/\/github\.com\/someone\//);
    assert.match(problems[2]!, /"elsewhere": an official example lives under https:\/\/github\.com\/e2e-inc\/ or https:\/\/gitlab\.com\/e2e_inc\//);
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
    const problems = registryProblems(
      registry([
        { ...community, repository: 'https://github.com/someone/vite-auth/tree/main/tests' },
        { ...community, slug: 'on-gitlab', repository: 'https://gitlab.com/someone/vite-auth/-/tree/main/tests' },
      ]),
      ENV,
    );
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0]!, /"vite-auth": a community example pins its repository to a commit/);
    assert.match(problems[1]!, /"on-gitlab": a community example pins its repository to a commit/);
  });

  it('accepts a community example pinned to a commit on GitLab, in nested groups, with a readme there', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const problems = registryProblems(
      registry([
        {
          ...community,
          repository: `https://gitlab.com/someone/web/vite-auth/-/tree/${sha}/tests`,
          readme: `https://gitlab.com/someone/web/vite-auth/-/blob/${sha}/docs/e2e.md`,
        },
        { ...community, slug: 'other-repo', repository: `https://gitlab.com/someone/web/vite-auth/-/tree/${sha}`, readme: `https://gitlab.com/someone/web/docs/-/blob/${sha}/e2e.md` },
      ]),
      ENV,
    );
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0]!, /"other-repo": readme must be a file in the example's repository, https:\/\/gitlab\.com\/someone\/web\/vite-auth\//);
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
  it('accepts a Markdown file on GitHub or GitLab, or false, and nothing else', () => {
    const json = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
    const [first] = json.examples;
    const withReadme = (readme: unknown) => schemaProblems({ ...json, examples: [{ ...first, readme }] });
    assert.deepEqual(withReadme('https://github.com/a/b/blob/main/docs/e2e.md'), []);
    assert.deepEqual(withReadme('https://gitlab.com/a/b/c/-/blob/main/docs/e2e.md'), []);
    assert.deepEqual(withReadme(false), []);
    for (const readme of [
      true,
      'https://github.com/a/b/tree/main/docs',
      'https://gitlab.com/a/b/blob/main/e2e.md',
      'https://example.com/e2e.md',
    ]) {
      assert.ok(withReadme(readme).some((problem) => problem.startsWith('/examples/0/readme')), String(readme));
    }
  });
});

describe('schemaProblems on repository', () => {
  it('accepts a GitHub or GitLab project or folder, and nothing else', () => {
    const json = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
    const [first] = json.examples;
    const withRepository = (repository: string) => schemaProblems({ ...json, examples: [{ ...first!, repository }] });
    for (const repository of ['https://gitlab.com/a/b', 'https://gitlab.com/a/b/c/-/tree/main/e2e', 'https://github.com/a/b/tree/main/e2e']) {
      assert.deepEqual(withRepository(repository), [], repository);
    }
    for (const repository of ['https://gitlab.com/a', 'https://gitlab.com/a/b/-/blob/main/README.md', 'https://bitbucket.org/a/b']) {
      assert.ok(withRepository(repository).some((problem) => problem.startsWith('/examples/0/repository')), repository);
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

  it("reads GitLab's raw files", () => {
    assert.equal(readmeUrl({ repository: 'https://gitlab.com/a/b' }), 'https://gitlab.com/a/b/-/raw/HEAD/README.md');
    assert.equal(readmeUrl({ repository: 'https://gitlab.com/a/b/c/-/tree/main/e2e' }), 'https://gitlab.com/a/b/c/-/raw/main/e2e/README.md');
    assert.equal(
      readmeUrl({ repository: 'https://gitlab.com/a/b/-/tree/abc/tests', readme: 'https://gitlab.com/a/b/-/blob/abc/docs/e2e.md' }),
      'https://gitlab.com/a/b/-/raw/abc/docs/e2e.md',
    );
  });
});
