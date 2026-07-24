function fmt(t) {
  if (!t || !isFinite(t)) return '';
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function scanChannelMessages(channel, knownUserId, electronAPI, log, isCancelled) {
  const messages = [];
  let lastId = null;
  let uid = knownUserId;
  let pages = 0;
  const MAX_PAGES = 10;

  while (!isCancelled() && pages < MAX_PAGES) {
    let result;
    try {
      result = await electronAPI.getGroupMessages(channel.id, lastId);
    } catch { break; }
    if (!result.success) {
      if (result.error === 'Rate limited') {
        await new Promise(resolve => setTimeout(resolve, ((result.retryAfter || 1) * 1000) + 500));
        continue;
      }
      break;
    }
    if (!result.messages || !result.messages.length) break;
    if (!uid && result.currentUserId) uid = result.currentUserId;

    for (const msg of result.messages) {
      if (msg.author && msg.author.id === uid) {
        const hasContent = (typeof msg.content === 'string' && msg.content.trim().length > 0)
          || (msg.attachments && msg.attachments.length > 0)
          || (msg.embeds && msg.embeds.length > 0)
          || msg.type === 'VOICE_MESSAGE';
        if (hasContent) messages.push({ channelId: channel.id, msg });
      }
    }
    pages++;
    if (result.messages.length < 100) break;
    lastId = result.messages[result.messages.length - 1].id;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  log(`#${channel.name}: ${messages.length}m ${pages}p`);
  return { channelId: channel.id, messages, currentUserId: uid };
}

function autoConcurrency(n) {
  if (n < 5) return 2;
  if (n < 10) return 4;
  if (n < 15) return 6;
  return 8;
}

const PANEL_STYLES = {
  container: `
    position:fixed;bottom:16px;right:16px;width:400px;
    background:#18191c;border:1px solid #303338;border-radius:8px;
    box-shadow:0 4px 24px rgba(0,0,0,.6);z-index:10000;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    font-size:13px;color:#dcddde;overflow:hidden
  `,
  header: `
    display:flex;justify-content:space-between;align-items:center;
    padding:12px 16px;background:#202225;border-bottom:1px solid #303338
  `,
  body: `padding:12px 16px`,
  barOuter: `
    width:100%;height:4px;background:#2f3136;border-radius:2px;
    overflow:hidden;margin:8px 0
  `,
  barInner: `
    height:100%;background:#5865f2;border-radius:2px;transition:width .3s ease
  `,
  row: `display:flex;justify-content:space-between;font-size:12px;color:#96989d`,
  tag: `
    display:inline-block;padding:1px 6px;border-radius:3px;
    font-size:10px;font-weight:600;text-transform:uppercase
  `,
};

export async function deleteServerMessages({
  serverId, serverName, electronAPI, onComplete = () => {},
}) {
  const panel = document.createElement('div');
  panel.id = 'taskPanel';
  panel.style.cssText = PANEL_STYLES.container;
  panel.innerHTML = `
    <div style="${PANEL_STYLES.header}">
      <span style="font-weight:600;font-size:14px;color:#fff">${serverName}</span>
      <span id="taskPhase" style="${PANEL_STYLES.tag};background:#5865f2;color:#fff">Scanning</span>
    </div>
    <div style="${PANEL_STYLES.body}">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px">
        <span id="taskStatus">Loading channels...</span>
        <span><span id="progressNum">0</span> / <span id="totalNum">0</span></span>
      </div>
      <div style="${PANEL_STYLES.barOuter}"><div id="barFill" style="${PANEL_STYLES.barInner}"></div></div>
      <div id="taskDetails" style="font-size:11px;color:#72767d;min-height:16px"></div>
      <div style="margin-top:8px">
        <button id="taskActionBtn" style="
          width:100%;padding:6px 0;border:none;border-radius:4px;
          cursor:pointer;font-size:12px;font-weight:500;
          background:#ed4245;color:#fff
        ">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  const phase = $('taskPhase');
  const status = $('taskStatus');
  const details = $('taskDetails');
  const progressNum = $('progressNum');
  const totalNum = $('totalNum');
  const barFill = $('barFill');
  const actionBtn = $('taskActionBtn');

  let shouldStop = false;
  const updateBar = (pct) => { if (barFill) barFill.style.width = `${Math.min(100, Math.max(0, pct))}%`; };

  const cleanExit = () => { panel.remove(); onComplete(); };

  actionBtn.onclick = () => {
    shouldStop = true;
    actionBtn.textContent = 'Stopping...';
    actionBtn.disabled = true;
  };

  const log = (msg) => {
    try { window.log?.(`[DelMessages] ${msg}`); } catch {}
    console.log(`[DelMessages] ${msg}`);
  };

  try {
    log('start');
    const chRes = await electronAPI.getServerChannels(serverId);
    if (!chRes.success || !chRes.channels.length) {
      if (status) status.textContent = 'No channels found';
      setTimeout(cleanExit, 1500);
      return;
    }

    const channels = chRes.channels;
    const concurrency = autoConcurrency(channels.length);
    if (status) status.textContent = `Scanning ${channels.length} channels (${concurrency}x)`;
    if (totalNum) totalNum.textContent = channels.length.toString();
    if (phase) phase.textContent = 'Scanning';

    const allMessages = [];
    let uid = null;
    let scanned = 0;
    let channelIdx = 0;

    async function worker() {
      while (channelIdx < channels.length && !shouldStop) {
        const idx = channelIdx++;
        const ch = channels[idx];
        if (status) status.textContent = `#${ch.name} (${idx + 1}/${channels.length})`;
        if (progressNum) progressNum.textContent = (idx + 1).toString();
        try {
          const result = await scanChannelMessages(ch, uid, electronAPI, log, () => shouldStop);
          uid = uid || result.currentUserId;
          allMessages.push(...result.messages);
          scanned++;
          updateBar((scanned / channels.length) * 100);
        } catch (e) {
          log(`#${ch.name} ${e.message}`);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, () => worker()));
    if (shouldStop) { log('cancel'); cleanExit(); return; }

    const total = allMessages.length;
    if (totalNum) totalNum.textContent = total.toString();
    log(`done: ${total}`);

    if (total === 0) {
      if (status) status.textContent = 'No messages to delete';
      if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
      updateBar(100);
      if (details) details.textContent = 'Nothing to delete';
      actionBtn.textContent = 'Close';
      actionBtn.style.background = '#3ba55d';
      actionBtn.disabled = false;
      actionBtn.onclick = cleanExit;
      setTimeout(cleanExit, 3000);
      return;
    }

    if (phase) { phase.textContent = 'Deleting'; phase.style.background = '#faa81a'; }
    if (status) status.textContent = `Deleting ${total} messages...`;
    if (totalNum) totalNum.textContent = total.toString();
    actionBtn.textContent = 'Stop';
    actionBtn.disabled = false;

    let deleted = 0;
    const delStart = Date.now();

    for (const item of allMessages) {
      if (shouldStop) break;
      let ok = false;
      try {
        await electronAPI.deleteGroupMessage(item.channelId, item.msg.id);
        ok = true;
      } catch (error) {
        if (error.response?.status === 429) {
          const retryAfter = parseInt(error.response.headers?.['retry-after']) || 5;
          await new Promise(resolve => setTimeout(resolve, (retryAfter * 1000) + 1000));
          try {
            await electronAPI.deleteGroupMessage(item.channelId, item.msg.id);
            ok = true;
          } catch { /* skip */ }
        }
        await new Promise(resolve => setTimeout(resolve, 2500));
      }

      if (ok) deleted++;
      if (progressNum) progressNum.textContent = deleted.toString();
      updateBar((deleted / total) * 100);

      if (details) {
        const elapsed = (Date.now() - delStart) / 1000;
        const rate = elapsed > 0 ? deleted / elapsed : 0;
        const eta = rate > 0 ? (total - deleted) / rate : 0;
        details.textContent = eta > 0 && isFinite(eta) ? `Deleted ${deleted}/${total} — ETA ${fmt(eta)}` : `Deleted ${deleted}/${total}`;
      }

      if (ok) await new Promise(resolve => setTimeout(resolve, deleted % 5 === 0 ? 1500 : 500));
    }

    log(`fin: ${deleted} ${fmt((Date.now() - delStart) / 1000)}`);
    updateBar(100);
    if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
    if (status) status.textContent = `Deleted ${deleted} messages`;
    actionBtn.textContent = 'Close';
    actionBtn.style.background = '#3ba55d';
    actionBtn.disabled = false;
    actionBtn.onclick = cleanExit;
    setTimeout(cleanExit, 5000);
  } catch (err) {
    console.error(err);
    log(`err: ${err.message}`);
    if (status) status.textContent = `Error: ${err.message}`;
    if (phase) { phase.textContent = 'Error'; phase.style.background = '#ed4245'; }
    setTimeout(cleanExit, 3000);
  }
}
