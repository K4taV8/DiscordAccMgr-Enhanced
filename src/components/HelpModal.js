// Modale d'aide — guide français des actions. Clôture : croix, Échap, clic
// extérieur, bouton « Compris ».
export function showHelpModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const cards = [
    {
      emoji: '🗑️',
      title: 'Supprimer les messages',
      body: 'Efface automatiquement tous vos messages dans la conversation, le MP ou le serveur sélectionné.',
      useCase: 'Purger un historique volumineux ou confidentiel, sans quitter le salon.',
    },
    {
      emoji: '💥',
      title: 'Supprimer les réactions',
      body: 'Retire automatiquement toutes vos réactions (émojis) posées sous les messages des salons scannés.',
      useCase: 'Effacer vos interactions et vos votes tout en conservant vos messages texte.',
    },
    {
      emoji: '🚪',
      title: 'Quitter',
      body: 'Fait sortir définitivement le compte du groupe ou du serveur sélectionné, en conservant vos messages.',
      useCase: 'Fermer proprement les conversations MP inactives et les serveurs que vous n\'utilisez plus.',
    },
    {
      emoji: '⚡',
      title: 'Nettoyer & Quitter',
      body: 'Enchaîne seul la séquence complète : suppression de vos messages ➔ de vos réactions ➔ sortie du groupe ou serveur.',
      useCase: 'La solution « zéro trace » : partir définitivement sans laisser de messages ni de réactions.',
    },
  ];

  overlay.innerHTML = `
    <div class="modal-content help-modal" role="dialog" aria-modal="true" aria-label="Aide">
      <h2>Comment fonctionne l'outil ?</h2>
      <p class="help-modal-intro">Sélectionnez une conversation, un groupe ou un serveur, puis choisissez une action : tout s\'exécute automatiquement, sans rechargement.</p>
      <div class="help-grid">
        ${cards.map(({ emoji, title, body, useCase }) => `
          <div class="help-card">
            <h3>${emoji} ${title}</h3>
            <p>${body}</p>
            <p class="use-case">💡 Quand l\'utiliser : ${useCase}</p>
          </div>`).join('')}
      </div>
      <button type="button" class="btn btn-primary" id="helpCloseBtn">Compris</button>
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
