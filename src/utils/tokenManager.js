import { showInputModal } from './ui.js';
import { updateTokensList } from './domManager.js';

export async function loadSavedTokens() {
    try {
        const result = await window.electronAPI.getTokens();
        if (!result.success) {
            console.error('Failed to load tokens:', result.error);
            return;
        }

        const tokenManagement = document.getElementById('tokenManagement');
        if (!tokenManagement) return;
if (!result.tokens.length) {
            tokenManagement.innerHTML = '<p class="text-muted">No saved tokens</p>';
            return;
        }

        updateTokensList(result.tokens, {
            useToken: (token) => {
                const input = document.getElementById('tokenInput');
                const btn = document.getElementById('connectBtn');
                if (input && btn) { input.value = token; btn.click(); }
            },
            deleteToken: async (name) => {
                try {
                    const r = await window.electronAPI.deleteToken(name);
                    if (r.success) loadSavedTokens();
                } catch (e) { console.error('Delete token error:', e); }
            }
});
    } catch (error) {
        console.error('Failed to load tokens:', error);
    }
}

export async function saveToken(token, status) {
    if (!token) {
        status.textContent = 'Please enter a token';
        status.className = 'error';
        return;
    }

    const name = await showInputModal('Save Token', 'Enter a name for this token:');
    if (!name) return;

    try {
        const result = await window.electronAPI.saveToken(name.trim(), token);
        if (result.success) {
            status.textContent = '';
            document.getElementById('tokenInput').value = '';
            await loadSavedTokens();
            showSavedFeedback();
        } else {
            status.textContent = result.error;
            status.className = 'error';
        }
    } catch (error) {
        status.textContent = 'Failed to save token';
        status.className = 'error';
    }
}

// Solution A : feedback temporaire "Saved ✓" sur le bouton Save (2s, pas de layout shift)
let savedTimer = null;
function showSavedFeedback() {
  const btn = document.getElementById('saveTokenBtn');
  if (!btn) return;
  clearTimeout(savedTimer);
  btn.classList.add('btn-saved');
  btn.innerHTML = 'Saved ✓';
  savedTimer = setTimeout(() => {
    btn.classList.remove('btn-saved');
    btn.innerHTML = 'Save';
  }, 2000);
}

