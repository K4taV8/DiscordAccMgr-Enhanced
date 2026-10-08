/**
 * Source : src/utils/discord.js (25 lignes) — typage strict, aucune
 * modification de logique.
 *
 * Les formes `success` / `error` des résultats IPC sont déjà déclarées dans
 * src/types/global.d.ts, déduites de electron/preload.cjs.
 */

export { copyToClipboard, showNotification } from './clipboard.js';

import type { DirectMessageSummary, FriendSummary, ServerSummary } from '../../shared/types';

// `result.error` peut être un objet (renvoyé par le main via IPC) malgré le type
// déclaré `string` → on n'émet jamais "[object Object]".
function errorMessage(error: unknown): string {
  return (error as { message?: string } | null | undefined)?.message || String(error);
}

export const getFriendsList = async (): Promise<FriendSummary[]> => {
  const result = await window.electronAPI.getFriends();
  if (!result.success) {
    throw new Error(errorMessage(result.error));
  }
  return result.friends || [];
};

export const getServersList = async (force = false): Promise<ServerSummary[]> => {
  const result = await window.electronAPI.getServers(force);
  if (!result.success) {
    throw new Error(errorMessage(result.error));
  }
  return result.servers || [];
};

export const getDMsList = async (): Promise<DirectMessageSummary[]> => {
  const result = await window.electronAPI.getDMs();
  if (!result.success) {
    throw new Error(errorMessage(result.error));
  }
  return result.dms || [];
};
