// BUG-08 : préserver le scroll après un refresh de liste (le scroll vit sur le .page-container)
export function preservePageScroll(contentArea, render) {
  const scroller = contentArea.closest('.page-container') || contentArea;
  const top = scroller.scrollTop;
  const html = render();
  contentArea.innerHTML = html;
  scroller.scrollTop = top;
}

// Update token list with icons
export function updateTokensList(tokens, handlers) {
  const tokenManagement = document.getElementById('tokenManagement');
  if (!tokenManagement) return;

  if (tokens.length === 0) {
    tokenManagement.innerHTML = '';
    return;
  }

  const tokenElements = tokens.map(t => {
    const div = document.createElement('div');
    div.className = 'token-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = t.corrupt ? `${t.name} (corrupted)` : t.name;
    if (t.corrupt) nameSpan.title = 'This token cannot be decrypted. Delete it and re-add it.';

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'button-group';

    const useBtn = document.createElement('button');
    useBtn.className = 'btn btn-secondary';
    useBtn.innerHTML = `
      Use
    `;
    useBtn.disabled = !!t.corrupt;
    useBtn.addEventListener('click', () => handlers.useToken(t.token));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-icon-danger';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<svg width="22" height="22" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17 6V4c0-1.1-.9-2-2-2H9c-1.1 0-2 .9-2 2v2H2v2h2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8h2V6zM9 4h6v2H9zM6 20V8h12v12z"></path><path d="M9 10h2v8H9zm4 0h2v8h-2z"></path></svg>';
    deleteBtn.addEventListener('click', () => handlers.deleteToken(t.name));

    buttonGroup.appendChild(useBtn);
    buttonGroup.appendChild(deleteBtn);

    div.appendChild(nameSpan);
    div.appendChild(buttonGroup);

    return div;
  });

  tokenManagement.innerHTML = '';
  tokenElements.forEach(el => tokenManagement.appendChild(el));
}