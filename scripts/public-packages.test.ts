import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isWidePeerRange, publicPackages, siblingPeers, widePeerRange } from './public-packages.ts';

describe('widePeerRange', () => {
  it('builds the floor the sibling was versioned at and drops a prerelease suffix', () => {
    assert.equal(widePeerRange('0.15.0'), '>=0.15.0 <1');
    assert.equal(widePeerRange('0.15.0-canary-20261022120000'), '>=0.15.0 <1');
    assert.equal(widePeerRange('1.2.3'), '>=1.2.3 <2');
  });

  it('refuses a version that is not semver', () => {
    assert.throws(() => widePeerRange('next'), /not semver/);
  });
});

describe('isWidePeerRange', () => {
  it('accepts the shape widePeerRange produces, whatever its floor', () => {
    assert.equal(isWidePeerRange('>=0.15.0 <1'), true);
    assert.equal(isWidePeerRange('>=1.2.3 <2'), true);
  });

  it('refuses narrower shapes, an exact pin, and a ceiling that is not the next major', () => {
    assert.equal(isWidePeerRange('^0.15.0'), false);
    assert.equal(isWidePeerRange('>=0.15.0'), false);
    assert.equal(isWidePeerRange('0.15.0'), false);
    assert.equal(isWidePeerRange('>=0.15.0 <1.0.0'), false);
    assert.equal(isWidePeerRange('>=0.15.0 <2'), false);
    assert.equal(isWidePeerRange('>=0.15.0-0 <1'), false);
  });
});

describe('siblingPeers', () => {
  it('keeps only the peers that name another public package, with their ranges', () => {
    const siblings = new Set(['e2e', '@e2e-dev/web']);
    assert.deepEqual(siblingPeers({ e2e: '>=0.15.0 <1', zod: '^3.0.0' }, siblings), [['e2e', '>=0.15.0 <1']]);
  });

  it('answers an empty list for a manifest without peers', () => {
    assert.deepEqual(siblingPeers(undefined, new Set(['e2e'])), []);
  });
});

describe('publicPackages', () => {
  it('reads every publishable package under packages/ as an absolute manifest path', () => {
    const packages = publicPackages();
    const names = packages.map(({ manifest }) => manifest.name);
    assert.ok(names.includes('e2e'), names.join(', '));
    assert.ok(names.includes('@e2e-dev/web'), names.join(', '));
    for (const { path, manifest } of packages) {
      assert.match(path, /packages[\\/][^\\/]+[\\/]package\.json$/);
      assert.equal(manifest.private, undefined);
      assert.ok(manifest.name.length > 0);
    }
  });
});
