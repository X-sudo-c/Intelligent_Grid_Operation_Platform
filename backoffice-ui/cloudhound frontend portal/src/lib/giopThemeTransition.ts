/** Eased color cross-fade when switching light ↔ dark (see index.css). */
export const GIOP_THEME_TRANSITION_MS = 650;

let transitionTimer: ReturnType<typeof setTimeout> | undefined;

function syncThemeTransitionCssVar(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(
    '--giop-theme-transition-ms',
    `${GIOP_THEME_TRANSITION_MS}ms`,
  );
}

syncThemeTransitionCssVar();

export function beginGiopThemeTransition(): void {
  const root = document.documentElement;
  syncThemeTransitionCssVar();
  root.classList.add('giop-theme-transition');
  if (transitionTimer !== undefined) {
    clearTimeout(transitionTimer);
  }
  transitionTimer = setTimeout(() => {
    root.classList.remove('giop-theme-transition');
    transitionTimer = undefined;
  }, GIOP_THEME_TRANSITION_MS);
}
