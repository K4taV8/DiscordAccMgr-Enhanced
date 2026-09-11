// Modale d'aide — guide français des actions. Clôture : croix, Échap, clic
// extérieur, bouton « Compris ».
export function showHelpModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const cards = [
    {
      emoji: '🗑️',
      title: 'Supprimer les messages',
      body: 'Consiste à analyser la conversation, le MP ou le serveur puis à effacer l\'ensemble des messages que vous avez envoyés.',
      useCase: 'Idéal si vous voulez purger un historique de discussion confidentiel ou encombré sans pour autant quitter le groupe ou le serveur.',
    },
    {
      emoji: '💥',
      title: 'Supprimer les réactions',
      body: 'Parcourt les salons et retire automatiquement l\'intégralité des réactions (émojis) que vous avez posées sous les messages.',
      useCase: 'Utile pour effacer vos traces d\'interactions et de votes sans supprimer vos messages texte.',
    },
    {
      emoji: '🚪',
      title: 'Quitter',
      body: 'Effectue la sortie définitive du groupe ou du serveur sélectionné.',
      useCase: 'Pour faire un nettoyage rapide des groupes MP inactifs ou quitter les serveurs inutilisés.',
    },
    {
      emoji: '⚡',
      title: 'Nettoyer & Quitter',
      body: 'Exécute en une seule commande la séquence automatisée : suppression de vos messages ➔ suppression de vos réactions ➔ sortie du groupe/serveur.',
      useCase: 'La solution « zéro trace » ultime. Parfait pour quitter définitivement un groupe privé ou un serveur sans laisser de messages ou de réactions derrière vous.',
    },
  ];

  overlay.innerHTML = `
    <div class="modal-content help-modal" role="dialog" aria-modal="true" aria-label="Aide">
      <h2>Comment fonctionne l'outil ?</h2>
      ${cards.map(({ emoji, title, body, useCase }) => `
        <div class="help-card">
          <h3>${emoji} ${title}</h3>
          <p>${body}</p>
          <p class="use-case">💡 Cas d'usage : ${useCase}</p>
        </div>`).join('')}
      <button type="button" class="btn btn-primary" id="helpCloseBtn">Compris</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#helpCloseBtn').addEventListener('click', close);

  return overlay;
}
