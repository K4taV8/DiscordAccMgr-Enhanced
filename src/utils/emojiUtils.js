// RÉFÉRENCE discrub (Souche TS) : encode un emoji pour une URL Discord.
// Custom → "name:id" (nom BRUT, jamais encodé) ; Unicode → nom URL-encodé.
// ⚠️ Ne PAS stripper U+FE0F (variation selector) : c'est ce qui rendait les
// réactions "supprimées" fantômes (le DELETE visait ❤ au lieu de ❤️ et Discord
// renvoyait 404 → l'outil comptait "supprimé" alors que la réaction restait).
export function formatEmojiForApi(emoji) {
  if (!emoji) return '';
  if (emoji.id) {
    return `${emoji.name}:${emoji.id}`;
  }
  return encodeURIComponent(emoji.name || '');
}

// For text content / HTML attribute values — use in ${...} inside innerHTML
export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// For JS strings in onclick="fn('${escJs(val)}')" — escapes for BOTH the double-quoted
// HTML attribute and the single-quoted JS string (safe against `"` username breakout)
export function escJs(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
