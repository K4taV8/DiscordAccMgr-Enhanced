import { deleteDMMessages } from './messageDeleter.js';

export async function handleBulkDMActions(selectedDMs, action, electronAPI) {
  const total = selectedDMs.length;
  let completed = 0;
  let shouldStop = false;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <h2>${action === 'delete' ? 'Deleting Messages' : 'Closing DMs'}</h2>
      <div class="progress-container">
        <div class="progress-track">
          <div class="progress-fill" style="width: 0%"></div>
        </div>
        <div class="progress-text">Processing DM ${completed + 1}/${total}</div>
      </div>
      <button class="btn btn-danger" id="bulkCancelBtn" style="margin-top:12px">Cancel All</button>
    </div>
  `;
  document.body.appendChild(modal);

  const stopState = { cancelled: false };
  modal.querySelector('#bulkCancelBtn').addEventListener('click', () => {
    stopState.cancelled = true;
    modal.querySelector('#bulkCancelBtn').disabled = true;
    modal.querySelector('.progress-text').textContent = 'Cancelling...';
  });

  const updateProgress = () => {
    completed++;
    const progress = (completed / total) * 100;
    modal.querySelector('.progress-fill').style.width = `${progress}%`;
    modal.querySelector('.progress-text').textContent = 
      completed < total ? `Processing DM ${completed + 1}/${total}` : 'Completed';
  };

  try {
    for (const dm of selectedDMs) {
      if (stopState.cancelled) break;
      if (action === 'delete') {
        const result = await deleteDMMessages({
          channelId: dm.id,
          username: dm.username,
          electronAPI,
          skipRefresh: true,
          quiet: true,
          isStopSignal: () => stopState.cancelled
        });
        if (result === 'cancelled') break;
      } else if (action === 'close') {
        await electronAPI.closeDM(dm.id);
      }
      updateProgress();
    }
  } finally {
    setTimeout(() => modal.remove(), 1000);
  }
}