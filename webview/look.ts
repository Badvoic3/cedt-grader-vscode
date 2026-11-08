import type { LookView } from '../src/shared/look';

/** Classes on the body; style.css, tests.css and statement.css do the rest. */
export function applyLook(look: LookView | undefined): void {
  const c = document.body.classList;
  c.toggle('fx', !!look?.on);
  c.toggle('fx-frost', !!look?.frost);
  if (look?.frost) document.documentElement.style.setProperty('--glass-opacity', `${look.frostOpacity}%`);
}

/** Motion is off when the OS asks for it, or VS Code's `workbench.reduceMotion` does (it sets a class on the body). */
export function reducedMotion(): boolean {
  return document.body.classList.contains('vscode-reduce-motion') || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}
