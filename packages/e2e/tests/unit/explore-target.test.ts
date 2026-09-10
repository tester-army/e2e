import { describe, expect, it } from 'vitest';
import { pickTarget } from '../../src/explore/index.ts';

const OPTIONS = { projectRoot: '/tmp/e2e-explore-target', env: { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv };

/** A web target with a declared URL, as an engine handle would declare it, without an engine. */
const WEB = { name: 'web', platform: 'web' as const };

describe('pickTarget', () => {
  it('explores the first target by its resolved name, and opens the app only when the target declares a URL', () => {
    const notices: string[] = [];
    // A target without an engine declares no URL: nothing to open first.
    const device = pickTarget({ targets: [{ name: 'phone', platform: 'ios' }] }, OPTIONS, undefined, (m) => notices.push(m));
    expect(device).toEqual({ ids: ['phone'], openApp: false });
    expect(notices).toEqual([]);
  });

  it('names the first of several targets and says so', () => {
    const notices: string[] = [];
    const picked = pickTarget({ targets: [WEB, { name: 'second', platform: 'web' }] }, OPTIONS, undefined, (m) => notices.push(m));
    expect(picked.ids).toEqual(['web']);
    expect(notices).toEqual(['exploring target "web"; pass --target to explore another']);
  });

  it('passes a requested name through, known or not, so the run reports an unknown one', () => {
    const notices: string[] = [];
    expect(pickTarget({ targets: [WEB, { name: 'second', platform: 'web' }] }, OPTIONS, 'second', (m) => notices.push(m))).toEqual({ ids: ['second'], openApp: false });
    expect(pickTarget({ targets: [WEB] }, OPTIONS, 'nope', (m) => notices.push(m))).toEqual({ ids: ['nope'], openApp: true });
    expect(notices).toEqual([]);
  });

  it('leaves a config that does not resolve to the run', () => {
    expect(pickTarget({ targets: [WEB], timeout: -1 }, OPTIONS, undefined, () => undefined)).toEqual({ ids: undefined, openApp: true });
  });
});
