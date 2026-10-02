/**
 * Augmentations globales du renderer.
 *
 * Formes déduites à l'identique de electron/preload.cjs : `electronAPI`
 * (lignes 24-67) et `persistAPI` (lignes 70-78). Aucun membre ajouté,
 * aucun membre omis.
 */

import type {
  ChannelMessagesResult,
  ChannelSummary,
  ConnectResult,
  DirectMessageSummary,
  FriendSummary,
  GroupSummary,
  LiveMessage,
  ReactionSummary,
  ReadAllResult,
  ServerSummary,
  TokenListResult,
  WriteResult,
} from '../../shared/types';
import type { Checkpoint, CheckpointOperation } from '../../shared/types';

export interface ReactionSummaryPayload {
  currentUserId: string;
  reactions: ReactionSummary[];
}

export interface ElectronAPI {
  // fenetre
  minimize(): void;
  maximize(): void;
  close(): void;

  // jetons
  getTokens(): Promise<TokenListResult>;
  saveToken(name: string, token: string): Promise<WriteResult>;
  deleteToken(name: string): Promise<WriteResult>;
  deleteAllTokens(): Promise<WriteResult>;
  connectByName(name: string): Promise<ConnectResult | { success: false; error: string }>;

  // application
  openExternal(url: string): Promise<{ success: boolean; error?: string }>;
  getAppVersion(): Promise<string>;
  toggleDevTools(): Promise<boolean>;

  // serveurs
  muteServer(serverId: string): Promise<{ success: boolean; error?: string }>;
  unmuteServer(serverId: string): Promise<{ success: boolean; error?: string }>;
  readAll(): Promise<ReadAllResult | { success: false; error: string }>;
  readServer(serverId: string): Promise<unknown>;
  onReadAllProgress(callback: (data: { done: number; total: number; failed: number }) => void): () => void;

  // connexion
  connectDiscord(token: string): Promise<ConnectResult>;
  getFriends(): Promise<{ success: boolean; friends?: FriendSummary[]; error?: string }>;
  deleteFriend(friendId: string): Promise<{ success: boolean; error?: string }>;
  getServers(force: boolean): Promise<{ success: boolean; servers?: ServerSummary[]; error?: string }>;
  getServerChannels(
    serverId: string,
  ): Promise<{ success: boolean; channels?: ChannelSummary[]; currentUserId?: string; error?: string }>;
  leaveServer(serverId: string): Promise<{ success: boolean; error?: string }>;
  getDMs(): Promise<{ success: boolean; dms?: DirectMessageSummary[]; error?: string }>;
  getDMMessages(channelId: string, beforeId: string | null): Promise<ChannelMessagesResult>;
  deleteDMMessage(channelId: string, messageId: string): Promise<{ success: boolean; error?: string }>;
  closeDM(channelId: string): Promise<{ success: boolean; error?: string }>;
  openDM(userId: string): Promise<{ success: boolean; error?: string }>;

  // groupes
  getGroups(): Promise<{ success: boolean; groups?: GroupSummary[]; error?: string }>;
  leaveGroup(groupId: string): Promise<{ success: boolean; error?: string }>;
  getChannelMessages(
    channelId: string,
    beforeId: string | null,
    afterId: string | null,
  ): Promise<ChannelMessagesResult>;
  getMessage(channelId: string, messageId: string): Promise<ReactionSummaryPayload | { success: false; error: string }>;
  deleteGroupMessage(channelId: string, messageId: string): Promise<{ success: boolean; error?: string }>;
  deletePackageMessage(channelId: string, messageId: string): Promise<{ success: boolean; error?: string }>;
  getChannel(channelId: string): Promise<{ success: boolean; status?: number; channel?: { id: string; name: string | null; type: number | null }; error?: string }>;

  removeOwnReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ success: boolean; error?: string }>;
}

export interface PersistAPI {
  checkpointLoad(op: CheckpointOperation, serverId: string): Promise<unknown>;
  checkpointSave(op: CheckpointOperation, serverId: string, cp: Checkpoint): Promise<void>;
  checkpointClear(op: CheckpointOperation, serverId: string): Promise<void>;
  watermarkGet(serverId: string): Promise<Record<string, WatermarkEntry>>;
  watermarkSet(serverId: string, map: Record<string, WatermarkEntry>): Promise<void>;
  ledgerGet(): Promise<Record<string, number>>;
  ledgerAdd(keys: string[]): Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    persistAPI: PersistAPI;
  }
}

export {};
