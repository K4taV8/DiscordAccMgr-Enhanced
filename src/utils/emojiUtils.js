export function formatEmojiForApi(emoji) {
  if (!emoji) return '';
  if (emoji.id && emoji.name) {
    return `${encodeURIComponent(emoji.name.replace(/\uFE0F/g, ''))}:${emoji.id}`;
  }
  if (emoji.id) {
    return `_:${emoji.id}`;
  }
  const name = (emoji.name || '').replace(/\uFE0F/g, '');
  if (!name) return '';
  return encodeURIComponent(name)
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
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
