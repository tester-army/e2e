import { useState } from 'react';
import { Icon } from './ui.tsx';

const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** Where the choice is kept; index.html reads the same key before first paint. */
const STORAGE_KEY = 'e2e-report-theme';

function currentTheme(): Theme {
  const { theme } = document.documentElement.dataset;
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

/**
 * Follows the system's theme or holds light or dark, set on the root as
 * `data-theme` and kept in local storage, so every report opened in this
 * browser keeps the choice.
 */
export function ThemeSwitch() {
  const [theme, setTheme] = useState(currentTheme);
  const choose = (next: Theme) => {
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be off (a private window, a strict file:// policy); the choice then lasts for this page.
    }
    setTheme(next);
  };
  return (
    <div role="group" aria-label="Theme" className="flex items-center gap-e2e-2">
      {THEMES.map((name) => (
        <button key={name} type="button" className="e2e-action" aria-label={name} title={name} aria-pressed={name === theme} onClick={() => choose(name)}>
          <Icon name={name} />
        </button>
      ))}
    </div>
  );
}
