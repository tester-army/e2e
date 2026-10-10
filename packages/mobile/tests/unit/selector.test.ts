import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MobilePlatform } from '../../src/options.ts';
import { projectSnapshot, type ProjectedNode, type RawNode } from '../../src/nodes.ts';
import { compileSelector } from '../../src/selector.ts';

function project(nodes: readonly RawNode[]): readonly ProjectedNode[] {
  let counter = 0;
  return projectSnapshot(nodes, { mintId: () => `n${(counter += 1)}` }).index;
}

/** A captured benchmark screen, projected the way `locate` projects it. */
function captured(platform: MobilePlatform, scenario: string): readonly ProjectedNode[] {
  const file = path.join(import.meta.dirname, '../fixtures/snapshots', platform, `${scenario}.json`);
  return project((JSON.parse(readFileSync(file, 'utf8')) as { nodes: RawNode[] }).nodes);
}

function ids(platform: MobilePlatform, selector: string, index = captured(platform, 'text-input-variations')): (string | undefined)[] {
  return compileSelector(selector, platform)(index).map((entry) => entry.raw.identifier);
}

const rect = { x: 0, y: 100, width: 200, height: 40 };

/** An Android form whose nodes fall on each side of agent-device's term rules. */
const ANDROID_FORM = project([
  { ref: 'e1', index: 0, depth: 0, type: 'android.widget.FrameLayout', rect: { x: 0, y: 0, width: 400, height: 800 } },
  { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'android.widget.EditText', identifier: 'email', enabled: true, rect },
  { ref: 'e3', index: 2, parentIndex: 0, depth: 1, type: 'android.widget.EditText', identifier: 'locked', enabled: false, rect },
  { ref: 'e4', index: 3, parentIndex: 0, depth: 1, type: 'android.widget.Button', identifier: 'Submit', label: 'Submit', hittable: true, rect },
  { ref: 'e5', index: 4, parentIndex: 0, depth: 1, type: 'android.view.View', identifier: 'spacer', rect: { x: 0, y: 0, width: 0, height: 0 } },
]);

describe('agent-device selector term rules', () => {
  it('reads editable as a fillable type that is enabled', () => {
    expect(ids('android', 'editable', ANDROID_FORM)).toEqual(['email']);
    expect(ids('android', 'editable=false', ANDROID_FORM)).not.toContain('email');
  });

  it('compares text case-insensitively', () => {
    expect(ids('android', 'id=EMAIL', ANDROID_FORM)).toEqual(['email']);
    expect(ids('android', 'label=submit', ANDROID_FORM)).toEqual(['Submit']);
  });

  it('reads visible as hittable or a non-empty frame', () => {
    expect(ids('android', 'hidden', ANDROID_FORM)).toEqual(['spacer']);
    expect(ids('android', 'visible', ANDROID_FORM)).toEqual([undefined, 'email', 'locked', 'Submit']);
  });

  it('matches hittable only on a node that reports it', () => {
    expect(ids('android', 'hittable', ANDROID_FORM)).toEqual(['Submit']);
  });

  it('matches every term of an alternative, and enabled by the node flag', () => {
    expect(ids('android', 'enabled=false', ANDROID_FORM)).toEqual(['locked']);
    expect(ids('android', 'role=text-field enabled=true', ANDROID_FORM)).toEqual(['email']);
  });
});

describe('agent-device selectors over captured device snapshots', () => {
  for (const platform of ['ios', 'android'] as const) {
    describe(platform, () => {
      it('matches editable by agent-device fillable types', () => {
        expect(ids(platform, 'editable')).toEqual(['username-input', 'pin-input', 'notes-input']);
      });

      it('matches text by the first non-empty label, value, or identifier', () => {
        expect(ids(platform, 'text=username-input')).toEqual(['username-input']);
      });

      it('matches role by the node kind, not the getByRole role', () => {
        expect(ids(platform, 'role=text-field')).toEqual(platform === 'ios' ? ['username-input'] : ['username-input', 'pin-input', 'notes-input']);
        expect(ids(platform, 'role=textbox')).toEqual([]);
      });

      it('returns every match of the first alternative that matches, in snapshot order', () => {
        expect(ids(platform, 'id=missing || editable || role=button')).toEqual(['username-input', 'pin-input', 'notes-input']);
        expect(ids(platform, 'id=missing')).toEqual([]);
      });
    });
  }

  it('rejects a ref, which is not a selector', () => {
    expect(() => compileSelector('@e3', 'ios')).toThrowError(expect.objectContaining({ code: 'ENGINE_FAILURE' }));
  });
});
