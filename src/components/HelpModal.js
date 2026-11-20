// Modale d'aide — guide de démarrage pour les nouveaux utilisateurs.
// Clôture : croix, Échap, clic extérieur, bouton « J'ai compris ».
export function showHelpModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  overlay.innerHTML = `
    <div class="modal-content help-modal" role="dialog" aria-modal="true" aria-label="Guide de démarrage">
      <header class="help-hero">
        <div class="help-hero-icon" aria-hidden="true">🧭</div>
        <div class="help-hero-copy">
          <h2>Bienvenue dans Discord Account Manager</h2>
          <p>Un guide simple pour prendre en main l'outil, comprendre les actions et éviter les erreurs.</p>
        </div>
      </header>

      <div class="help-body">
      <section class="help-section">
        <h3><span class="help-step">1</span> Se connecter</h3>
        <p>Clique sur <strong>Connexion avec Discord</strong> : une fenêtre Discord s'ouvre, tu te connectes normalement (mot de passe, 2FA ou QR code), puis l'app récupère ta session.</p>
        <p>Tu peux aussi coller un <strong>token</strong> dans le champ prévu, puis cliquer sur <strong>Se connecter</strong>. Le bouton <strong>Enregistrer</strong> garde ce token pour la prochaine fois.</p>
        <p class="help-tip">🔐 Ton token est un secret : ne le partage jamais. Si tu utilises la connexion Discord, ton mot de passe reste dans la fenêtre Discord et ne passe jamais par l'app.</p>
      </section>

      <section class="help-section">
        <h3><span class="help-step">2</span> Choisir une page</h3>
        <div class="help-page-grid">
          <div><strong><span class="icon icon-18 icon-group" aria-hidden="true"></span> Amis</strong><span>Voir tes amis, copier un identifiant ou retirer un ami.</span></div>
          <div><strong><span class="icon icon-18 icon-hashtag" aria-hidden="true"></span> Serveurs</strong><span>Tes serveurs : messages, réactions, sourdine, tout marquer comme lu, quitter.</span></div>
          <div><strong><span class="icon icon-18 icon-discussion" aria-hidden="true"></span> MP</strong><span>Tes conversations privées : messages, réactions, fermer la conversation.</span></div>
          <div><strong><span class="icon icon-18 icon-community" aria-hidden="true"></span> Groupes</strong><span>Tes conversations à plusieurs : messages, réactions, quitter le groupe.</span></div>
          <div><strong>📦 Archive</strong><span>Importer ton export Discord (.zip) pour explorer tes messages et tes médias.</span></div>
          <div><strong><span class="icon icon-18 icon-brush" aria-hidden="true"></span> Thème</strong><span>Change l'apparence de l'app avec le bouton pinceau, en bas du rail.</span></div>
        </div>
      </section>

      <section class="help-section">
        <h3><span class="help-step">3</span> Agir sur une fiche</h3>
        <div class="help-action-grid">
          <div class="help-action-card">
            <h4>🗑️ Supprimer les messages</h4>
            <p>Efface <strong>tes</strong> messages dans la conversation ou le serveur. Les messages des autres ne sont pas touchés.</p>
          </div>
          <div class="help-action-card">
            <h4>💥 Retirer les réactions</h4>
            <p>Retire les réactions que <strong>tu</strong> as posées, sans supprimer les messages.</p>
          </div>
          <div class="help-action-card">
            <h4>🚪 Quitter</h4>
            <p>Quitte un serveur ou un groupe, ou ferme un MP. Tes messages restent en place.</p>
          </div>
          <div class="help-action-card">
            <h4>⚡ Nettoyer &amp; quitter</h4>
            <p>Enchaîne messages → réactions → sortie. La solution « zéro trace » pour partir proprement.</p>
          </div>
        </div>
      </section>

      <section class="help-section">
        <h3><span class="help-step">4</span> Nettoyer plusieurs éléments</h3>
        <p>Coche plusieurs fiches (ou utilise <strong>Tout sélectionner</strong>). Une barre d'actions apparaît en bas : elle propose <strong>Nettoyer</strong> avec 4 modes : messages, réactions, les deux, ou tout + quitter.</p>
        <p>Les opérations longues affichent une progression et peuvent être arrêtées avec le bouton <strong>Arrêter</strong>. Si une opération est interrompue, l'app te propose de <strong>reprendre</strong> là où elle s'est arrêtée.</p>
        <p class="help-tip">🧹 Commence par une seule conversation pour te familiariser. Les suppressions sont <strong>définitives</strong>.</p>
      </section>

      <section class="help-section">
        <h3><span class="help-step">5</span> L'archive Discord</h3>
        <p>Dans <strong>Archive</strong>, glisse ton export Discord <strong>.zip</strong> ou sélectionne-le. L'app le lit en local, puis tu peux explorer les messages par salon et la galerie de photos, vidéos, audio et fichiers.</p>
        <p>Le bouton <strong>Télécharger les médias</strong> crée une copie locale pour consulter la galerie hors ligne. <strong>Purger les médias</strong> libère cet espace.</p>
        <p class="help-warning">⚠️ <strong>Fonctionnalité en cours de test.</strong> L'import et l'exploration d'archives sont encore en développement : des instabilités et des bugs sont possibles. À utiliser uniquement si tu es curieux.</p>
      </section>

      <section class="help-section help-safety">
        <h3>✅ À retenir</h3>
        <ul>
          <li>Les suppressions sont <strong>irréversibles</strong> : vérifie toujours la sélection avant de lancer.</li>
          <li>L'app respecte le débit de Discord : les grosses opérations peuvent prendre du temps.</li>
          <li>Tu peux arrêter une opération et la reprendre plus tard sans tout recommencer.</li>
          <li>Utilise l'app avec <strong>ton propre compte</strong>, sous ta responsabilité : l'usage d'un token utilisateur est contraire aux conditions d'utilisation de Discord.</li>
        </ul>
      </section>
      </div>

      <footer class="help-footer">
        <span class="help-footer-note">Tu peux rouvrir ce guide à tout moment avec le bouton <strong>?</strong> du rail.</span>
        <button type="button" class="btn btn-primary" id="helpCloseBtn">J'ai compris</button>
      </footer>
    </div>
  `;

  document.body.appendChild(overlay);

  // `close()` peut être déclenché deux fois (Échap + clic backdrop, ou bouton) :
  // la garde évite d'empiler `transitionend` et les `setTimeout` de retrait.
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKey);
    // Sortie identique à l'îlot de thème : fade + léger repli, puis retrait du
    // nœud sur transitionend (setTimeout = filet si la transition ne part pas).
    const panel = overlay.querySelector('.modal-content');
    panel.classList.add('is-closing');
    const done = () => overlay.remove();
    panel.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 240);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#helpCloseBtn').addEventListener('click', close);

  return overlay;
}
