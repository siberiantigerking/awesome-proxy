import type { Theme } from '../types';

/**
 * Apply a theme by toggling the `dark` class on <html>, which Tailwind's
 * class-based dark mode keys off. 'system' follows the OS preference.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  let dark: boolean;

  if (theme === 'system') {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } else {
    dark = theme === 'dark';
  }

  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/**
 * Keep the app in sync with OS theme changes while in 'system' mode.
 * Returns a cleanup function.
 */
export function watchSystemTheme(getTheme: () => Theme): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (getTheme() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
