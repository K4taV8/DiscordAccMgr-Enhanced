/**
 * RÉFÉRENCE discrub (Souche TS) : encode un emoji pour une URL Discord.
 * Custom → "name:id" (nom BRUT, jamais encodé) ; Unicode → nom URL-encodé.
 * ⚠️ Ne PAS stripper U+FE0F (variation selector) : c'est ce qui rendait les
 * réactions "supprimées" fantômes (le DELETE visait ❤ au lieu de ❤️ et Discord
 * renvoyait 404 → l'outil comptait "supprimé" alors que la réaction restait).
 *
 * Source : src/utils/emojiUtils.js (17 lignes) — typage strict, aucune
 * modification de logique. Cible des tests test/utils.test.js.
 */

/** Emoji brut ou déjà custom (`id` renseigné). */
export interface RawEmoji {
  id?: string | null;
  name?: string | null;
}

export function formatEmojiForApi(emoji: RawEmoji | null | undefined): string {
  if (!emoji) return '';
  if (emoji.id) {
    return `${emoji.name}:${emoji.id}`;
  }
  return encodeURIComponent(emoji.name || '');
}

/** For text content / HTML attribute values — use in ${...} inside innerHTML */
export function escHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
