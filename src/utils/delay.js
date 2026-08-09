// Humanized delays — anti-rate-limit (ported pattern from Souche delayUtils, kept dependency-free)
export function humanDelay(base, variancePct = 0.35) {
  return Math.round(base * (1 - variancePct + Math.random() * variancePct * 2));
}

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));