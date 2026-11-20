'use strict';

// POSSIBLE 1 de l'audit : pendant ~1 à 3 minutes après le démarrage, le
// préchauffage du login maintient une fenêtre CACHÉE. `getAllWindows()[0]`
// pouvait donc ouvrir les DevTools de la page Discord au lieu de l'application.
// F12 vise désormais EXPLICITEMENT la fenêtre principale.
function toggleDevTools(window) {
  try {
    if (!window || window.isDestroyed?.()) return false;
    const contents = window.webContents;
    if (!contents || typeof contents.toggleDevTools !== 'function') return false;
    contents.toggleDevTools();
    return true;
  } catch {
    return false;
  }
}

module.exports = { toggleDevTools };
