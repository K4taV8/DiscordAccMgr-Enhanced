export const copyToClipboard = async (text) => {
    try {
        await navigator.clipboard.writeText(text);
        showNotification('Copié dans le presse-papiers !');
    } catch (error) {
        console.error('Échec de la copie :', error);
    }
};

export const showNotification = (message) => {
  const notification = document.createElement('div');
  notification.className = 'copy-notification';
  notification.textContent = message;
  document.body.appendChild(notification);
  // Un resume de suppression peut faire 80 caracteres : deux secondes
  // disparaissent avant d avoir ete lu. La duree suit la longueur.
  const text = String(message || '');
  const duration = Math.min(9000, Math.max(2600, 2600 + text.length * 55));
  notification.style.animationDuration = `${duration}ms`;
  setTimeout(() => notification.remove(), duration);
};