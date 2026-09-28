/**
 * Persistance locale côté renderer — checkpoints, watermarks (delta), ledger
 * anti-fantômes. Les écritures sont asynchrones + atomiques côté main.
 * Ce module ne touche `window.persistAPI` qu'à l'appel (testable en Node).
 *
 * Source : src/utils/persist.js (65 lignes) — typage strict, aucune
 * modification de logique. Cible des tests test/persist.test.js.
 */

import type { Checkpoint, CheckpointChannel, CheckpointOperation, CheckpointPhase } from '../../shared/types';
import type { WatermarkEntry } from './persist.types';

export const OP_REACTIONS = 'removeReactions';
export const OP_MESSAGES = 'deleteMessages';
export const LEDGER_TTL = 24 * 3600 * 1000;
export const WATERMARK_TTL = 24 * 3600 * 1000;

/** Descripteur de canal fourni par le renderer à `newCheckpoint`. */
export interface CheckpointChannelSeed {
  id: string;
  name: string;
}

// ---- Checkpoint ----

/**
 * Charge un checkpoint. Ne renvoie que les enveloppes de schéma 1.
 * Renvoie `undefined` (et non `null`) quand `persistAPI` est absent : le
 * chaînage optionnel `?.` de l'original se propage tel quel.
 */
export async function loadCheckpoint(
  op: CheckpointOperation,
  serverId: string,
): Promise<Checkpoint | null | undefined> {
  const cp: unknown = await window.persistAPI?.checkpointLoad(op, serverId);
  return isSchemaV1(cp) ? cp : null;
}

/** `cp.schemaVersion === 1`, avec vérification de forme. */
function isSchemaV1(cp: unknown): cp is Checkpoint {
  return typeof cp === 'object' && cp !== null && (cp as { schemaVersion?: unknown }).schemaVersion === 1;
}

export function saveCheckpoint(
  op: CheckpointOperation,
  serverId: string,
  cp: Checkpoint,
): Promise<void> | undefined {
  return window.persistAPI?.checkpointSave(op, serverId, cp);
}

export function clearCheckpoint(
  op: CheckpointOperation,
  serverId: string,
): Promise<void> | undefined {
  return window.persistAPI?.checkpointClear(op, serverId);
}

export function newCheckpoint(
  op: CheckpointOperation,
  serverId: string,
  serverName: string,
  channels: CheckpointChannelSeed[],
): Checkpoint {
  const ch: Record<string, CheckpointChannel> = {};
  for (const c of channels) {
    ch[c.id] = { name: c.name, status: 'pending', cursor: null, found: 0, newestId: null };
  }
  return {
    schemaVersion: 1,
    operation: op,
    serverId,
    serverName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'scan' as CheckpointPhase,
    channels: ch,
    queue: [],
    progress: { done: 0, total: 0, failed: 0 },
  };
}

export function touch(cp: Checkpoint): Checkpoint {
  cp.updatedAt = Date.now();
  return cp;
}

// ---- Watermark (delta : dernier id vu par canal) ----

export async function loadWatermark(serverId: string): Promise<Record<string, WatermarkEntry>> {
  return window.persistAPI?.watermarkGet(serverId) || {};
}

export function saveWatermark(
  serverId: string,
  wm: Record<string, WatermarkEntry>,
): Promise<void> | undefined {
  return window.persistAPI?.watermarkSet(serverId, wm);
}

/** Vrai si l'entrée est plus récente que `ttl`. `false`/undefined si absente. */
export function watermarkFresh(
  entry: WatermarkEntry | undefined,
  ttl: number = WATERMARK_TTL,
): boolean | undefined {
  return entry && Date.now() - entry.scannedAt < ttl;
}

// ---- Ledger anti-fantômes (réactions confirmées supprimées) ----

export async function loadLedger(): Promise<Record<string, number>> {
  const s: unknown = await window.persistAPI?.ledgerGet();
  return typeof s === 'object' && s !== null ? (s as Record<string, number>) : {};
}

export function addLedger(keys: string[] | undefined): Promise<void> | undefined {
  if (keys && keys.length) return window.persistAPI?.ledgerAdd(keys);
  return Promise.resolve();
}

export function ledgerKey(channelId: string, messageId: string, emojiStr: string): string {
  return `${channelId}:${messageId}:${emojiStr}`;
}

/** Filtre les entrées périmées ; retourne un Map <clé, timestamp> vivant. */
export function ledgerFilter(map: Record<string, number>, ttl: number = LEDGER_TTL): Map<string, number> {
  const now: number = Date.now();
  const out: Map<string, number> = new Map<string, number>();
  for (const [k, ts] of Object.entries(map)) {
    if (typeof ts === 'number' && now - ts < ttl) out.set(k, ts);
  }
  return out;
}
