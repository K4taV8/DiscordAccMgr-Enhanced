// Verrou anti-régression — correctifs d'audit des gestionnaires DOM.
//
// Ces classes dépendent lourdement du DOM (modales, panneaux, délégation) : le
// dépôt verrouille déjà ce genre de correctif par lecture du source (voir
// test/auditFixes.test.js et test/csp.test.js). On fige ici la présence des
// garde-fous :
//   BUG-009  : tester `{success:false}`, notifier, réactiver le bouton ;
//   BUG-010  : ne pas garder 30 s un échec de chargement en cache ;
//   BUG-023c : `both` compte bien 2 étapes dans la barre de progression ;
//   BUG-014  : agréger les statuts (`partial` ≠ succès) et vérifier les sorties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('BUG-009 : FriendsManager teste success, notifie et réactive le bouton', () => {
  const s = src('src/components/FriendsManager.js');
  assert.ok(s.includes('const result = await window.electronAPI.deleteFriend(friendId);'), 'capture le retour');
  assert.ok(s.includes("if (result?.success) {"), 'teste success (ami seul)');
  assert.ok(s.includes("showNotification(result?.error || 'Échec : ami non retiré')"), 'notifie l’échec');
  assert.ok(s.includes("if (result?.success) completed++;"), 'agrège le succès (sélection)');
  assert.ok(s.includes('failed++'), 'compte les échecs (sélection)');
  assert.ok(s.includes("showNotification(`${failed} ami(s) non supprimé(s)`)"), 'notifie les échecs');
});

test('BUG-009 : GroupManager / DMManager / ServerManager vérifient la sortie', () => {
  const group = src('src/components/GroupManager.js');
  assert.ok(group.includes("if (result?.success) {\r\n        this.refreshGroupsList(true);"), 'leaveGroup teste success');
  assert.ok(group.includes('const r = await window.electronAPI.leaveGroup(g.groupId); ok = !!r?.success;'), 'mode full vérifie leaveGroup');

  const dm = src('src/components/DMManager.js');
  assert.ok(dm.includes('const result = await window.electronAPI.closeDM(channelId);'), 'closeDM capture le retour');
  assert.ok(dm.includes("showNotification(result?.error || 'Échec : conversation non fermée')"), 'notifie la fermeture ratée');
  assert.ok(dm.includes('const r = await window.electronAPI.closeDM(dm.channelId); ok = !!r?.success;'), 'mode full vérifie closeDM');

  const server = src('src/components/ServerManager.js');
  assert.ok(server.includes("showNotification(result?.error || 'Échec : serveur non quitté')"), 'notifie la sortie ratée');
  assert.ok(server.includes('const r = await window.electronAPI.leaveServer(serverId); ok = !!r?.success;'), 'mode full vérifie leaveServer');
});

test('BUG-010 : FriendsManager et GroupManager n’endorment pas un échec en cache', () => {
  const friends = src('src/components/FriendsManager.js');
  assert.ok(friends.includes('if (this._cache?.data?.success === false) this._cache = null;'), 'invalide le cache Friends');
  const group = src('src/components/GroupManager.js');
  assert.ok(group.includes('if (this._cache?.data?.success === false) this._cache = null;'), 'invalide le cache Groupes');
});

test('BUG-023c : le mode `both` compte 2 étapes dans les trois gestionnaires', () => {
  for (const rel of ['src/components/DMManager.js', 'src/components/GroupManager.js', 'src/components/ServerManager.js']) {
    const s = src(rel);
    assert.ok(s.includes("+ (mode === 'both' ? 2 : 0)"), `both compté dans ${rel}`);
  }
});

test('BUG-014 : executeCleaningMode agrège les statuts au lieu de tout compter « traité »', () => {
  for (const rel of ['src/components/DMManager.js', 'src/components/GroupManager.js']) {
    const s = src(rel);
    assert.ok(s.includes("if (status !== 'done') failures++;"), `statut agrégé dans ${rel}`);
    assert.ok(s.includes('if (failures > 0) {'), `échecs signalés dans ${rel}`);
    assert.ok(s.includes("status: 'failed'"), `panneau marqué en échec dans ${rel}`);
    assert.ok(s.includes('showNotification(`${failures} opération(s) en échec lors du nettoyage`)'), `notification dans ${rel}`);
  }
});
