import { describe, expect, it } from 'vitest';
import {
  deriveChecked,
  isScrollContainer,
  normalizeRole,
  roleKey,
} from '../../src/roles.ts';

describe('roleKey', () => {
  it('folds platform spellings onto one comparison key', () => {
    expect(roleKey('XCUIElementTypeSecureTextField')).toBe('secure-text-field');
    expect(roleKey('secure-text-field')).toBe('secure-text-field');
    expect(roleKey('android.widget.EditText')).toBe('edit-text');
    expect(roleKey('static_text')).toBe('static-text');
  });
});

describe('normalizeRole', () => {
  it('maps iOS element types to their ARIA roles', () => {
    const cases: readonly [string, string][] = [
      ['XCUIElementTypeButton', 'button'],
      ['XCUIElementTypeSecureTextField', 'textbox'],
      ['XCUIElementTypeSearchField', 'searchbox'],
      ['XCUIElementTypeStaticText', 'paragraph'],
      ['XCUIElementTypeSwitch', 'switch'],
      ['XCUIElementTypeNavigationBar', 'navigation'],
      ['XCUIElementTypeTabBar', 'tablist'],
      ['XCUIElementTypeSegmentedControl', 'tablist'],
      ['XCUIElementTypeAlert', 'alertdialog'],
      ['XCUIElementTypeCell', 'listitem'],
      ['XCUIElementTypeCollectionView', 'list'],
      ['XCUIElementTypePickerWheel', 'combobox'],
      ['XCUIElementTypeStatusBar', 'banner'],
      ['XCUIElementTypeWebView', 'document'],
      ['XCUIElementTypeWindow', 'generic'],
    ];
    for (const [type, role] of cases) {
      expect(normalizeRole({ type }, 'ios'), type).toBe(role);
    }
  });

  it('maps Android classes to their ARIA roles', () => {
    const cases: readonly [string, string][] = [
      ['android.widget.Button', 'button'],
      ['android.widget.ImageButton', 'button'],
      ['android.widget.EditText', 'textbox'],
      ['android.widget.TextView', 'paragraph'],
      ['android.widget.SeekBar', 'slider'],
      ['android.widget.RatingBar', 'slider'],
      ['android.widget.Spinner', 'combobox'],
      ['androidx.recyclerview.widget.RecyclerView', 'list'],
      ['android.widget.SwitchCompat', 'switch'],
      ['android.webkit.WebView', 'document'],
      ['android.widget.FrameLayout', 'generic'],
    ];
    for (const [type, role] of cases) {
      expect(normalizeRole({ type }, 'android'), type).toBe(role);
    }
  });

  it('splits Android CheckedTextView on its checkable state', () => {
    const type = 'android.widget.CheckedTextView';
    expect(normalizeRole({ type }, 'android', { checkable: true })).toBe('checkbox');
    expect(normalizeRole({ type }, 'android', { checkable: false })).toBe('paragraph');
  });

  it('treats a direct child of an Android list as a listitem', () => {
    expect(normalizeRole({ type: 'android.view.View' }, 'android', { parentRole: 'list' })).toBe(
      'listitem',
    );
    expect(normalizeRole({ type: 'android.view.View' }, 'android')).toBe('generic');
  });

  it('prefers role, then subrole, then native type', () => {
    expect(normalizeRole({ role: 'button', type: 'XCUIElementTypeOther' }, 'ios')).toBe('button');
    expect(normalizeRole({ subrole: 'link', type: 'XCUIElementTypeOther' }, 'ios')).toBe('link');
    expect(normalizeRole({ type: 'XCUIElementTypeOther' }, 'ios')).toBe('generic');
  });

  it('normalizes an unmapped element type to generic', () => {
    expect(normalizeRole({ type: 'XCUIElementTypeTouchBar' }, 'ios')).toBe('generic');
    expect(normalizeRole({}, 'android')).toBe('generic');
  });
});

describe('isScrollContainer', () => {
  it('recognizes the scrollable types of both platforms', () => {
    expect(isScrollContainer({ type: 'XCUIElementTypeScrollView' })).toBe(true);
    expect(isScrollContainer({ type: 'androidx.recyclerview.widget.RecyclerView' })).toBe(true);
    expect(isScrollContainer({ type: 'android.widget.Button' })).toBe(false);
  });
});

describe('deriveChecked', () => {
  it('derives only for checkbox, radio, and switch', () => {
    expect(deriveChecked('switch', '1', undefined)).toBe(true);
    expect(deriveChecked('checkbox', 'false', undefined)).toBe(false);
    expect(deriveChecked('radio', 'checked', undefined)).toBe(true);
    expect(deriveChecked('button', '1', undefined)).toBeUndefined();
    expect(deriveChecked('paragraph', 'true', true)).toBeUndefined();
  });

  it('falls back to the selected state when no value is exposed', () => {
    expect(deriveChecked('switch', undefined, true)).toBe(true);
    expect(deriveChecked('switch', undefined, false)).toBe(false);
    expect(deriveChecked('switch', undefined, undefined)).toBeUndefined();
  });

  it('leaves the state unavailable for a value it cannot interpret', () => {
    expect(deriveChecked('switch', 'partially', true)).toBeUndefined();
  });
});
