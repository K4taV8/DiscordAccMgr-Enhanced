export function canUsePackageWorker() {
  return typeof Worker !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined';
}

// fflate est chargé depuis le renderer actuel ; cette couche reste opt-in afin de
// conserver le fallback synchrone compatible avec Electron sans bundler.
export function runInWorker(task, { onProgress = () => {} } = {}) {
  if (!canUsePackageWorker()) return Promise.reject(new Error('Workers unavailable'));
  return new Promise((resolve, reject) => {
    const source = `self.onmessage = async ({ data }) => { try { self.postMessage({ type: 'unsupported', task: data.task }); } catch (error) { self.postMessage({ type: 'error', message: error.message }); } };`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = event => {
      if (event.data.type === 'progress') onProgress(event.data);
      else if (event.data.type === 'error') { worker.terminate(); URL.revokeObjectURL(url); reject(new Error(event.data.message)); }
      else { worker.terminate(); URL.revokeObjectURL(url); reject(new Error('Package worker is not configured for this build.')); }
    };
    worker.onerror = error => { worker.terminate(); URL.revokeObjectURL(url); reject(error); };
    worker.postMessage({ task });
  });
}
