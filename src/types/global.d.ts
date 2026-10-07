/**
 * Augmentations globales du renderer.
 *
 * Formes déduites à l'identique de electron/preload.cjs : `electronAPI`
 * (lignes 68-120) et `persistAPI` (lignes 122-130). Aucun membre ajouté,
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
  PackageMessage,
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

/** Un salon du paquet, tel que l'assemblage le produit. */
export interface ImportedChannel {
  id: string;
  name: string | null;
  avatar: string | null;
  recipient: { id?: string; username?: string; globalName?: string | null; avatar?: string | null } | null;
  type: string;
  guildName?: string | null;
  guildId?: string | null;
  isLeft: boolean;
  messagesCount: number;
}

/**
 * Le paquet renvoyé par `discord:importPackage`, SUR LE FIL.
 *
 * `messages` est un OBJET indexé par identifiant de salon, et non une `Map`.
 * Raison exacte : l'aplatissement est VOLONTAIRE et explicite, pas une
 * limitation du transport — l'IPC Electron sérialise ses arguments par clonage
 * structuré, qui préserve `Map` et `Set` (`structuredClone(new Map(a)) instanceof Map
 * === true`). Un objet se inspecte dans un journal et se compare dans un test,
 * là où une `Map` ne se compare pas.
 *
 * Le renderer le retransforme (`hydrateImportedPackage`) avant de s'en servir.
 * Une troisième forme existe, pour la BASE : un tableau de paires, dans
 * `src/services/packageStorage.service.js` (IndexedDB ne stocke pas une clé
 * d'objet). Les trois sont nommées là où elles sont écrites.
 */
export interface ImportedPackage {
  user: { id: string; username: string; globalName: string | null; avatar: string | null };
  guilds: { id: string; name: string; icon: string | null }[];
  channels: ImportedChannel[];
  messages: Record<string, PackageMessage[]>;
  totalMessages: number;
  packageSizeBytes: number;
  discarded: { noise: number; oversized: number };
}

/**
 * Réponse de `discord:importPackage`.
 *
 * - `success` : `package` est complet, `reason` n'est non nul que si l'import a
 *   fini par le chemin flux après un échec du chemin index.
 * - `cancelled` : l'import a ete arrete. Ce n'est ni un succes ni un echec
 *   d'archive, et aucun paquet n'est rendu — un paquet partiel se presenterait
 *   comme un import complet.
 * - `fallbackToRenderer` : le main process ne peut pas importer du tout (pas de
 *   chemin, module du chemin flux introuvable). Le renderer refait l'import
 *   lui-meme, et non un second essai cote main.
 */
export type PackageImportResponse =
  | { success: true; package: ImportedPackage; mode: 'index' | 'stream'; reason: string | null; cancelled?: false; error?: undefined }
  | { success: false; cancelled: true; mode: 'index' | 'stream'; reason: string | null; error?: undefined; fallbackToRenderer?: undefined }
  | { success: false; fallbackToRenderer: true; error: string; mode?: 'index' | 'stream'; reason?: string | null; cancelled?: undefined }
  | { success: false; fallbackToRenderer?: undefined; cancelled?: false; mode: 'index' | 'stream'; reason: string; error: string };

/** Progression d'un import. `fichier` designe l'archive concernee. */
export interface PackageImportProgress {
  fichier: string;
  current: number;
  total: number;
  stage: string;
  bytes?: boolean;
  channelId?: string;
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

  // import de paquet (ZIP) — le main process lit le fichier par tranches, les
  // octets ne traversent pas l'IPC
  importPackage(file: File): Promise<PackageImportResponse>;
  onImportPackageProgress(callback: (info: PackageImportProgress) => void): () => void;

  // sortie de secours d'une piece jointe : le renderer ne peut pas fetch le CDN
  // (connect-src 'self'), le main process telecharge et ecrit le fichier.
  saveAttachment(
    attachment: { url: string; fileName: string },
  ): Promise<{ ok: boolean; chemin?: string; cancelled?: boolean; error?: string }>;

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
  setThreadArchived(threadId: string, archived: boolean): Promise<{ success: boolean; status?: number; error?: string }>;

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
