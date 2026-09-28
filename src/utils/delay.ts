/**
 * Humanized delays — anti-rate-limit (ported pattern from Souche delayUtils,
 * kept dependency-free).
 *
 * Source : src/utils/delay.js (6 lignes) — typage strict, aucune modification
 * de logique. Cible des tests test/utils.test.js.
 */
export function humanDelay(base: number, variancePct = 0.35): number {
  return Math.round(base * (1 - variancePct + Math.random() * variancePct * 2));
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
