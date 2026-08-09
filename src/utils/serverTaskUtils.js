import { escHtml } from './emojiUtils.js';

export function fmt(t) {
  if (!t || !isFinite(t)) return '';
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function autoConcurrency(n) {
  if (n < 3) return 1;
  if (n < 8) return n;
  return 8;
}

export function createTaskPanel(serverName, logPrefix) {
  const existing = document.getElementById('taskPanel');
  if (existing) existing.remove(); // BUG-09 : un seul panneau — la tâche la plus récente gagne
  
  const panel = document.createElement('div');
  panel.id = 'taskPanel';
  panel.className = 'task-panel';
  panel.innerHTML = `
    <div class="task-panel-header">
      <span style="font-size:14px;color:#fff">${escHtml(serverName)}</span>
      <span id="taskPhase" class="task-phase">Scanning</span>
    </div>
    <div class="task-panel-body">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px">
        <span id="taskStatus">Loading channels...</span>
        <span><span id="progressNum">0</span> / <span id="totalNum">0</span></span>
      </div>
      <div class="progress-track"><div id="barFill" class="progress-fill"></div></div>
      <div id="taskDetails" class="task-details"></div>
      <div style="margin-top:8px">
        <button id="taskActionBtn" class="btn btn-danger" style="width:100%">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  const refs = {
    phase: $('taskPhase'),
    status: $('taskStatus'),
    details: $('taskDetails'),
    progressNum: $('progressNum'),
    totalNum: $('totalNum'),
    barFill: $('barFill'),
    actionBtn: $('taskActionBtn'),
  };

  const timers = [];
  let _shouldStop = false;

  const updateBar = (pct) => {
    if (refs.barFill) refs.barFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  };

  const cancelTimers = () => { timers.forEach(clearTimeout); timers.length = 0; };

  const cleanExit = (onComplete) => {
    cancelTimers();
    panel.remove();
    onComplete();
  };

  refs.actionBtn.onclick = () => {
    _shouldStop = true;
    refs.actionBtn.textContent = 'Stopping...';
    refs.actionBtn.disabled = true;
  };

  const log = (msg) => {
    try { window.log?.(`${logPrefix} ${msg}`); } catch {}
    console.log(`${logPrefix} ${msg}`);
  };

  const safeTimeout = (fn, ms) => {
    const id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  };

  return { ...refs, panel, timers, cancelTimers, _shouldStop, shouldStop: () => _shouldStop, setStop: (v) => { _shouldStop = v; }, updateBar, cleanExit, log, safeTimeout };
}
