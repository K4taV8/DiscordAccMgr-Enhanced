// Persistance locale côté renderer — checkpoints, watermarks (delta), ledger
// anti-fantômes. Les écritures sont asynchrones + atomiques côté main.
// Ce module ne touche `window.persistAPI` qu'à l'appel (testable en Node).

export const OP_REACTIONS = 'removeReactions';
export const OP_MESSAGES = 'deleteMessages';
export const LEDGER_TTL = 24 * 3600 * 1000;
export const WATERMARK_TTL = 24 * 3600 * 1000;

// ---- Checkpoint ----
export async function loadCheckpoint(op, serverId) {
  const cp = await window.persistAPI?.checkpointLoad(op, serverId);
  return cp && cp.schemaVersion === 1 ? cp : null;
}
export function saveCheckpoint(op, serverId, cp) {
  return window.persistAPI?.checkpointSave(op, serverId, cp);
}
export function clearCheckpoint(op, serverId) {
  return window.persistAPI?.checkpointClear(op, serverId);
}

export function newCheckpoint(op, serverId, serverName, channels) {
  const ch = {};
  for (const c of channels) ch[c.id] = { name: c.name, status: 'pending', cursor: null, found: 0, newestId: null };
  return {
    schemaVersion: 1, operation: op, serverId, serverName,
    createdAt: Date.now(), updatedAt: Date.now(),
    phase: 'scan', channels: ch, queue: [], progress: { done: 0, total: 0, failed: 0 },
  };
}

export function touch(cp) { cp.updatedAt = Date.now(); return cp; }

// ---- Watermark (delta : dernier id vu par canal) ----
export async function loadWatermark(serverId) {
  return window.persistAPI?.watermarkGet(serverId) || {};
}
export function saveWatermark(serverId, wm) {
  return window.persistAPI?.watermarkSet(serverId, wm);
}
export function watermarkFresh(entry, ttl = WATERMARK_TTL) {
  return entry && Date.now() - entry.scannedAt < ttl;
}

// ---- Ledger anti-fantômes (réactions confirmées supprimées) ----
export async function loadLedger() {
  const s = await window.persistAPI?.ledgerGet();
  return s && typeof s === 'object' ? s : {};
}
export function addLedger(keys) {
  if (keys && keys.length) return window.persistAPI?.ledgerAdd(keys);
  return Promise.resolve();
}
export function ledgerKey(channelId, messageId, emojiStr) {
  return `${channelId}:${messageId}:${emojiStr}`;
}
// Filtrer les entrées périmées ; retourne un Map <clé, timestamp> vivant.
export function ledgerFilter(map, ttl = LEDGER_TTL) {
  const now = Date.now();
  const out = new Map();
  for (const [k, ts] of Object.entries(map)) {
    if (typeof ts === 'number' && now - ts < ttl) out.set(k, ts);
  }
  return out;
}
