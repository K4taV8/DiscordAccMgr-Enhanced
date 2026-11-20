export class ProgressBar {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.progress = 0;
    this.isRunning = false;
    this.options = {
      showCancelButton: options.showCancelButton || false
    };
  }

  create() {
    this.progressText = document.createElement('div');
    this.progressText.textContent = '0%';

    this.track = document.createElement('div');
    this.track.className = 'progress-track';

    this.fill = document.createElement('div');
    this.fill.className = 'progress-fill';
    this.fill.style.width = '0%';

    this.track.appendChild(this.fill);

    if (this.options.showCancelButton) {
      this.cancelButton = document.createElement('button');
      this.cancelButton.textContent = 'Annuler';
      this.cancelButton.className = 'btn btn-danger';
    }

    this.container.appendChild(this.progressText);
    this.container.appendChild(this.track);
    if (this.cancelButton) {
      this.container.appendChild(this.cancelButton);
    }
  }

  update(progress) {
    this.progress = Math.min(Math.max(progress, 0), 100);
    this.fill.style.width = `${this.progress}%`;
    this.progressText.textContent = `${Math.round(this.progress)}%`;
  }

  show() {
    this.isRunning = true;
    this.track.style.display = 'block';
    if (this.cancelButton) {
      this.cancelButton.style.display = 'block';
    }
  }

  hide() {
    this.isRunning = false;
    this.track.style.display = 'none';
    if (this.cancelButton) {
      this.cancelButton.style.display = 'none';
    }
  }

  onCancel(callback) {
    if (this.cancelButton) {
      this.cancelButton.onclick = () => {
        if (this.isRunning) {
          callback();
        }
      };
    }
  }

  setCancelButtonText(text) {
    if (this.cancelButton) {
      this.cancelButton.textContent = text;
    }
  }

  disableCancelButton() {
    if (this.cancelButton) {
      this.cancelButton.disabled = true;
    }
  }
}
