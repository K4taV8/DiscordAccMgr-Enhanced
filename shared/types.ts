/**
 * shared/types.ts — contrats partagés du main process, du preload et du
 * renderer. Fichier de types uniquement : aucune logique, aucun effet de bord.
 *
 * Règle appliquée : chaque membre ci-dessous est issu d'une occurrence
 * vérifiée dans les fichiers `.cjs` / `.js` d'origine, ligne indiquée en
 * commentaire. Rien n'est ajouté qui n'existe déjà en production.
 */

/**
 * Échec de compilation sur une variante d'union non traitée.
 * Utilisé en `default:` des switch exhaustifs (cf. CheckpointPhase).
 */
export function assertNever(value: never, context?: string): never {
  throw new Error(`Unhandled variant${context ? ` (${context})` : ''}: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Types de canal et de relation Discord
// ---------------------------------------------------------------------------

/**
 * Types de canal manipulés par le code. Recensement exhaustif :
 *  - main.cjs:189  `ch.type === 3`            (groupes)
 *  - main.cjs:480  `ch.type === 1`            (DM)
 *  - main.cjs:593  `isMessageBearingChannel(ch.type)` — le filtre serveur
 *  - packageData.service.js:21,22,25 et packageImporter.service.js:220,223
 *  - `2` (voice) et `13` (scène) sont utilisés par ce filtre : leur chat
 *    intégré est adressable comme celui d'un salon texte.
 */
export enum ChannelType {
  /** 0 — salon texte de serveur. */
  GuildText = 0,
  /** 1 — message direct. */
  DirectMessage = 1,
  /** 2 — vocal ; porte un chat texte intégré (main.cjs:593). */
  GuildVoice = 2,
  /** 3 — DM de groupe. */
  GroupDirectMessage = 3,
  /** 5 — salon d'annonce. */
  GuildAnnouncement = 5,
  /** 10 — fil d'annonce. */
  AnnouncementThread = 10,
  /** 11 — fil public. */
  PublicThread = 11,
  /** 12 — fil privé. */
  PrivateThread = 12,
  /** 13 — scène ; porte un chat texte intégré (main.cjs:593). */
  GuildStageVoice = 13,
  /** 15 — forum. */
  GuildForum = 15,
  /** 16 — salon média. */
  GuildMedia = 16,
}

/**
 * Type de relation. Volontairement distinct de ChannelType : la seule
 * occurrence du code est main.cjs:465 `relationship.type === 1`, qui teste
 * une relation (ami) et non un canal — les deux domaines partagent le
 * littéral 1 sans partager le type.
 */
export enum RelationshipType {
  /** 1 — ami. */
  Friend = 1,
}

/**
 * `MESSAGE_BEARING_CHANNEL_TYPES` et `isMessageBearingChannel` vivent dans
 * electron/helpers.cjs (seul lisible à l'exécution et par `node --test`).
 * Les déclarer ici créait deux sources de vérité.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Pièce jointe d'un message issu d'un data package. Forme réelle : parseAttachments(), packageImporter.service.js:27-40. */
export interface Attachment {
  url: string;
  fileName: string;
}

/**
 * Message « live » : lu sur l'API Discord via main.cjs:220-238.
 * `attachments` est un COMPTEUR, pas une liste — c'est la distinction qui
 * rendait possible la confusion U2.
 */
export interface LiveMessage {
  source?: 'live';
  id: string;
  content: string;
  author: { id?: string };
  type: number;
  attachments: number;
  embeds: number;
  sticker_items: number;
  message_snapshots: number;
  message_reference: unknown | null;
  isDeletable: boolean;
  reactions: ReactionSummary[];
}

/**
 * Message « package » : reconstruit depuis un data package, forme réelle
 * packageImporter.service.js:65-71 et 80-86. `attachments` est une LISTE.
 */
export interface PackageMessage {
  source?: 'package';
  id: string;
  channelId: string;
  timestamp: string;
  content: string;
  attachments: Attachment[];
}

/**
 * Union discriminée. Le discriminant effectif est le type de `attachments`
 * (`number` vs `Attachment[]`) : l'usage de `source` est une étiquette
 * documentaire optionnelle, car la rendre obligatoire obligerait à ajouter
 * un champ aux charges utiles IPC déjà consommées par le renderer, ce qui
 * constituerait un changement de comportement. L'union interdit malgré tout
 * `LiveMessage.attachments = Attachment[]` et réciproquement : la confusion
 * U2 reste impossible à compiler.
 */
export type Message = LiveMessage | PackageMessage;

/** Résumé d'une réaction. main.cjs:231-237. */
export interface ReactionSummary {
  emoji: { id?: string | null; name?: string | null };
  count: number;
  me: boolean;
}

// ---------------------------------------------------------------------------
// Checkpoints de persistance
// ---------------------------------------------------------------------------

/**
 * Phases de checkpoint. Recensement :
 *  - persist.js:28                `phase: 'scan'`
 *  - serverMessageDeleter.js:155  `=== 'scan'` ; :249 `= 'delete'`
 *  - serverReactionRemover.js:118 `=== 'scan'` ; :187 `= 'delete'` ; :256 `= 'verifying'`
 *
 * `'done'` est demandé par le plan mais n'est produit nulle part dans le code
 * actuel : il est déclaré, jamais attribué.
 */
export type CheckpointPhase = 'scan' | 'delete' | 'verifying' | 'done';

/** Statut d'un canal dans un checkpoint : 'pending' / 'scanning' / 'scanned' (serverMessageDeleter.js:144,181,193 ; serverReactionRemover.js:106,136). */
export type CheckpointChannelStatus = 'pending' | 'scanning' | 'scanned';

/** Entrée par canal du checkpoint. Forme : persist.js:24, serverMessageDeleter.js:144. */
export interface CheckpointChannel {
  name: string;
  status: CheckpointChannelStatus;
  cursor: string | null;
  found: number;
  newestId: string | null;
}

/** Compteurs de progression. persist.js:28. */
export interface CheckpointProgress {
  done: number;
  total: number;
  failed: number;
}

/** Checkpoint complet. Forme : persist.js:22-30. */
export interface Checkpoint {
  schemaVersion: 1;
  operation: CheckpointOperation;
  serverId: string;
  serverName: string;
  createdAt: number;
  updatedAt: number;
  phase: CheckpointPhase;
  channels: Record<string, CheckpointChannel>;
  queue: string[];
  progress: CheckpointProgress;
}

/** Opérations de persistance autorisées — helpers.cjs:13 (`isOp`). */
export type CheckpointOperation = 'removeReactions' | 'deleteMessages';

// ---------------------------------------------------------------------------
// Résultat et codes d'erreur
// ---------------------------------------------------------------------------

/**
 * Codes d'erreur littéraux, recensés dans le code de production.
 *
 * `error` n'est pas toujours un littéral : main.cjs construit aussi des
 * messages dynamiques — `error.message` (L163, 217, 372, 386, 452, 519, 528)
 * et `HTTP ${status}` (L180, 187, 216, 252, 272, 497, 519, 528, 562, 587).
 * C'est la raison pour laquelle Result<> distingue CodedFailure (ensemble
 * fermé, exhaustif) de UncodedFailure (message d'exécution).
 */
export type ErrorCode =
  // main.cjs
  | 'Not connected' // L140, L298
  | 'Rate limited' // L158, 182, 214, 270, 495, 518, 527
  | 'No access' // L215
  | 'not found' // L271, L496
  | 'Failed to fetch servers' // L329
  | 'URL not allowed' // L380
  | 'Already connecting' // L425
  | 'Connection failed' // L452 (repli)
  | 'empty emoji key' // L507
  | 'noReaction' // L516
  | 'invalidEmoji' // L517
  | 'Failed to get reactions' // L528
  // tokenStore.cjs
  | 'Cannot save: secure storage unavailable. On Linux, install libsecret.' // L64
  | 'A token with this name already exists' // L70
  | 'Failed to save token' // L76
  | 'Failed to load tokens' // L114
  | 'Failed to delete token' // L127
  | 'Failed to delete tokens' // L138
  | 'Invalid token name' // L147
  | 'Cannot connect: secure storage unavailable. On Linux, install libsecret.' // L149
  | 'Token not found' // L153
  | 'Token is corrupted or not securely stored (re-save it)'; // L160

/** Succès porteur de `data`. */
export type Success<T> = { success: true; data: T };

/** Échec dont le message est un ErrorCode connu — ensemble fermé, vérifiable. */
export type CodedFailure = {
  success: false;
  error: ErrorCode;
  status?: number;
  retryAfter?: number;
};

/**
 * Échec dont le message est fabriqué à l'exécution (`error.message`,
 * `HTTP ${status}`). Distinct de CodedFailure pour qu'un `error: string`
 * n'élargisse pas silencieusement l'ensemble des codes « connus ».
 */
export type UncodedFailure = {
  success: false;
  error: string;
  status?: number;
  retryAfter?: number;
};

export type Result<T> = Success<T> | CodedFailure | UncodedFailure;

// ---------------------------------------------------------------------------
// Charges utiles IPC — formes réelles construites par main.cjs
// ---------------------------------------------------------------------------

/** Groupe DM. main.cjs:191-200. */
export interface GroupSummary {
  id: string;
  name: string;
  icon: string | null;
  recipients: number;
  members: { id: string; avatar: string | null }[];
}

/** Ami. main.cjs:466-471. `username`/`displayName` sont copiés tels quels :
 *  main.cjs n'applique AUCUN repli sur ces deux champs, contrairement à
 *  DirectMessageSummary — d'où `string | undefined`. */
export interface FriendSummary {
  id: string;
  username: string | undefined;
  displayName: string | undefined;
  avatar: string;
}

/** DM. main.cjs:481-488. */
export interface DirectMessageSummary {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
}

/** Serveur. main.cjs:564-571. */
export interface ServerSummary {
  id: string;
  name: string;
  owner: boolean;
  icon: string;
}

/** Canal de serveur. main.cjs:592. */
export interface ChannelSummary {
  id: string;
  name: string;
  type: ChannelType;
}

/** Résultat d'une lecture de messages. main.cjs:239. */
export interface ChannelMessagesPayload {
  success: true;
  currentUserId: string | undefined;
  messages: LiveMessage[];
}

/** Échec d'une lecture de messages. main.cjs:214-217. */
export type ChannelMessagesFailure = {
  success: false;
  error: string;
  retryAfter?: number;
};

export type ChannelMessagesResult = ChannelMessagesPayload | ChannelMessagesFailure;

/** Progression de `discord:readAll`. main.cjs:350. */
export interface ReadAllProgress {
  done: number;
  total: number;
  failed: number;
}

/** Résultat de `discord:readAll`. main.cjs:369. */
export interface ReadAllResult {
  success: true;
  failed: number;
  done: number;
  total: number;
  partial: boolean;
}

/** Utilisateur connecté renvoyé par `discord:connect`. main.cjs:439-449. */
export interface ConnectedUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
}

/** Résultat de connexion. main.cjs:439-452. */
export type ConnectResult =
  | { success: true; username: string; avatar: string; user: ConnectedUser }
  | { success: false; error: string };

/**
 * Métadonnées de jeton — le secret ne transite JAMAIS vers le renderer
 * (SEC-03, tokenStore.cjs:88-102). `token` est absent par construction.
 */
export interface TokenSummary {
  name: string;
  corrupt: boolean;
}

/** Résultat d'une écriture du store de jetons. tokenStore.cjs:74, 78. */
export interface WriteResult {
  success: boolean;
  error?: string;
}

/** Résultat de `tokenStore.list()`. tokenStore.cjs:112, 114. */
export type TokenListResult = { success: true; tokens: TokenSummary[] } | { success: false; error: string };

/**
 * Résultat de `tokenStore.resolveByName()`. tokenStore.cjs:147-161.
 * Discriminé par la présence de `token` : `{ token?: undefined }` /
 * `{ error?: undefined }` rendent les deux lectures (`resolved.error` puis
 * `resolved.token`) sûres sans changer la forme à l'exécution.
 */
export type ResolveTokenResult =
  | { token: string; userId?: string; error?: undefined }
  | { error: string; token?: undefined };
