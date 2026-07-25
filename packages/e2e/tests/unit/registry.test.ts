import { describe, expect, it } from 'vitest';
import { collectFromRegistration } from '../../src/collect/collect.js';
import { collectModule, test } from '../../src/collect/registry.js';
import { CollectionError } from '../../src/internal/errors.js';

const noop = async () => {};

describe('registration', () => {
  it('registers tests synchronously in declaration order', async () => {
    const registration = await collectModule(async () => {
      test('first', noop);
      test('second', { tags: ['smoke'] }, noop);
    });
    expect(registration.tests.map((item) => item.title)).toEqual(['first', 'second']);
    expect(registration.tests[0]!.declarationIndex).toBeLessThan(
      registration.tests[1]!.declarationIndex,
    );
  });

  it('returns a branded TestCase and ignores it for discovery', async () => {
    const registration = await collectModule(async () => {
      const testCase = test('kept once', noop);
      expect(testCase).toBeDefined();
    });
    expect(registration.tests).toHaveLength(1);
  });

  it('rejects registration outside collection', () => {
    expect(() => test('orphan', noop)).toThrow(/collected by the e2e runner/);
  });

  it('rejects registration after module evaluation (timers, promises)', async () => {
    let late: (() => void) | undefined;
    await collectModule(async () => {
      test('on time', noop);
      late = () => test('too late', noop);
    });
    expect(late!).toThrow(/after module evaluation|collected by the e2e runner/);
  });

  it('describe nests titles and must be synchronous', async () => {
    const registration = await collectModule(async () => {
      test.describe('outer', () => {
        test.describe('inner', () => {
          test('leaf', noop);
        });
      });
    });
    expect(registration.tests[0]!.titlePath).toEqual(['outer', 'inner', 'leaf']);
  });

  it('rejects async describe bodies', async () => {
    await expect(
      collectModule(async () => {
        test.describe('bad', (async () => {}) as never);
      }),
    ).rejects.toThrow(/synchronously/);
  });

  it('records skip and only modes', async () => {
    const registration = await collectModule(async () => {
      test.skip('skipped', noop);
      test.only('focused', noop);
      test('opt-skip', { skip: 'flaky upstream' }, noop);
    });
    expect(registration.tests.map((item) => item.mode)).toEqual(['skip', 'only', 'skip']);
    expect(registration.tests[2]!.options.skip).toBe('flaky upstream');
  });

  it('validates titles', async () => {
    await expect(
      collectModule(async () => {
        test('', noop);
      }),
    ).rejects.toThrow(/1 through 512/);
  });

  it('validates retries bounds', async () => {
    await expect(
      collectModule(async () => {
        test('x', { retries: 11 }, noop);
      }),
    ).rejects.toThrow(/0 through 10/);
  });
});

describe('setup tests', () => {
  it('requires a static sessions list with valid names', async () => {
    await expect(
      collectModule(async () => {
        test.setup('auth', { sessions: [] }, noop);
      }),
    ).rejects.toThrow(/at least one session/);
    await expect(
      collectModule(async () => {
        test.setup('auth', { sessions: ['bad name!'] }, noop);
      }),
    ).rejects.toThrow(/invalid session name/);
  });

  it('must be top-level', async () => {
    await expect(
      collectModule(async () => {
        test.describe('group', () => {
          test.setup('auth', { sessions: ['a'] }, noop);
        });
      }),
    ).rejects.toThrow(/top-level/);
  });
});

describe('serial groups', () => {
  it('rejects nested serial groups', async () => {
    await expect(
      collectModule(async () => {
        test.describe('outer', { serial: true }, () => {
          test.describe('inner', { serial: true }, () => {
            test('x', noop);
          });
        });
      }),
    ).rejects.toThrow(/nested serial/);
  });

  it('rejects member overrides of unit-owned options', async () => {
    for (const options of [{ retries: 1 }, { session: 's' }, { skip: true }, { only: true }]) {
      await expect(
        collectModule(async () => {
          test.describe('unit', { serial: true }, () => {
            test('member', options as never, noop);
          });
        }),
      ).rejects.toThrow(/serial group/);
    }
  });

  it('allows member tags, timeout, and agent context', async () => {
    const registration = await collectModule(async () => {
      test.describe('unit', { serial: true }, () => {
        test('member', { tags: ['a'], timeout: 5000, agentContext: 'ctx' }, noop);
      });
    });
    expect(registration.tests).toHaveLength(1);
  });
});

describe('collectFromRegistration', () => {
  it('derives stable IDs and detects duplicate title paths', async () => {
    const registration = await collectModule(async () => {
      test('one', noop);
      test.setup('auth', { sessions: ['member'] }, noop);
      test.describe('grp', () => {
        test('two', noop);
      });
    });
    const collected = collectFromRegistration('/root', '/root/tests/a.e2e.ts', registration);
    expect(collected.file).toBe('tests/a.e2e.ts');
    expect(collected.tests.map((item) => item.id)).toEqual([
      'tests/a.e2e.ts::one',
      'setup::tests/a.e2e.ts::auth',
      'tests/a.e2e.ts::grp::two',
    ]);

    const duplicate = await collectModule(async () => {
      test('same', noop);
      test('same', noop);
    });
    expect(() => collectFromRegistration('/root', '/root/tests/b.e2e.ts', duplicate)).toThrow(
      CollectionError,
    );
  });

  it('marks serial members with the unit source ID', async () => {
    const registration = await collectModule(async () => {
      test.describe('wizard', { serial: true }, () => {
        test('step 1', noop);
        test('step 2', noop);
      });
    });
    const collected = collectFromRegistration('/root', '/root/tests/wizard.e2e.ts', registration);
    expect(collected.tests[0]!.serialId).toBe('serial::tests/wizard.e2e.ts::wizard');
    expect(collected.tests[1]!.serialId).toBe('serial::tests/wizard.e2e.ts::wizard');
  });

  it('rejects files outside the project root', async () => {
    const registration = await collectModule(async () => {
      test('x', noop);
    });
    expect(() => collectFromRegistration('/root/app', '/elsewhere/b.e2e.ts', registration)).toThrow(
      /outside the project root/,
    );
  });
});
