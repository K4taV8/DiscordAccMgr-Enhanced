function emojiKey(emoji) {
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

function fmt(t) {
  if (!t || !isFinite(t)) return '';
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function scanChannelReactions(channel, electronAPI, log, isCancelled) {
  const reactions = [];
  let lastId = null;
  let pages = 0;
  const MAX_PAGES = 10;

  while (!isCancelled() && pages < MAX_PAGES) {
    let result;
    try {
      result = await electronAPI.getGroupMessages(channel.id, lastId);
    } catch (e) { log(`#${channel.name} fetch err`); break; }
    if (!result.success) {
      if (result.error === 'Rate limited') {
        await new Promise(resolve => setTimeout(resolve, ((result.retryAfter || 1) * 1000) + 500));
        continue;
      }
      if (result.error === 'No access') break;
      break;
    }
    if (!result.messages || !result.messages.length) break;
    for (const msg of result.messages) {
      if (msg.reactions) {
        for (const r of msg.reactions) {
          // ponytail: me unreliable from API for guild channels, try all via parallel DELETE
          reactions.push({ channelId: channel.id, messageId: msg.id, emoji: r.emoji });
        }
      }
    }
    pages++;
    if (result.messages.length < 100) break;
    lastId = result.messages[result.messages.length - 1].id;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  log(`#${channel.name}: ${reactions.length}r ${pages}p`);
  return reactions;
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

export async function removeServerReactions({
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
    try { window.log?.(`[RmReactions] ${msg}`); } catch {}
    console.log(`[RmReactions] ${msg}`);
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

    const allReactions = [];
    let scanned = 0;
    let channelIdx = 0;

    async function worker() {
      while (channelIdx < channels.length && !shouldStop) {
        const idx = channelIdx++;
        const ch = channels[idx];
        if (status) status.textContent = `#${ch.name} (${idx + 1}/${channels.length})`;
        if (progressNum) progressNum.textContent = (idx + 1).toString();
        try {
          const found = await scanChannelReactions(ch, electronAPI, log, () => shouldStop);
          allReactions.push(...found);
          scanned++;
          updateBar((scanned / channels.length) * 100);
        } catch (e) {
          log(`#${ch.name} ${e.message}`);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, () => worker()));
    if (shouldStop) { log('cancelled'); cleanExit(); return; }

    const total = allReactions.length;
    if (totalNum) totalNum.textContent = total.toString();
    log(`done: ${total}`);

    if (total === 0) {
      if (status) status.textContent = 'No reactions found';
      if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
      updateBar(100);
      if (details) details.textContent = 'Nothing to remove';
      actionBtn.textContent = 'Close';
      actionBtn.style.background = '#3ba55d';
      actionBtn.disabled = false;
      actionBtn.onclick = cleanExit;
      setTimeout(cleanExit, 3000);
      return;
    }

    if (phase) { phase.textContent = 'Removing'; phase.style.background = '#faa81a'; }
    if (status) status.textContent = `Processing ${total} reactions...`;
    if (totalNum) totalNum.textContent = total.toString();
    if (progressNum) progressNum.textContent = '0';
    actionBtn.textContent = 'Stop';
    actionBtn.disabled = false;
    updateBar(0);

    let removed = 0;
    let processed = 0;
    let delIdx = 0;
    const delStart = Date.now();
    const delConcurrency = 8;

    async function delWorker() {
      while (delIdx < allReactions.length && !shouldStop) {
        const idx = delIdx++;
        const item = allReactions[idx];
        let ok = false;
        try {
          const r = await electronAPI.removeOwnReaction(item.channelId, item.messageId, emojiKey(item.emoji));
          if (r.success) ok = true;
          else if (r.error === 'Rate limited') {
            await new Promise(resolve => setTimeout(resolve, ((r.retryAfter || 5) * 1000) + 1000));
            const retry = await electronAPI.removeOwnReaction(item.channelId, item.messageId, emojiKey(item.emoji));
            if (retry.success) ok = true;
          } // 404 / noReaction → skip fast, no delay
        } catch {}

        if (ok) removed++;
        processed++;
        if (progressNum && processed % 10 === 0) progressNum.textContent = removed.toString();
        updateBar((processed / allReactions.length) * 100);

        if (details) {
          details.textContent = `Checked ${processed}/${total} — removed ${removed}`;
        }

        if (ok) await new Promise(resolve => setTimeout(resolve, removed % 5 === 0 ? 3000 : 1000));
      }
    }
    await Promise.all(Array.from({ length: delConcurrency }, () => delWorker()));

    log(`fin: ${removed} ${fmt((Date.now() - delStart) / 1000)}`);
    updateBar(100);
    if (phase) { phase.textContent = 'Done'; phase.style.background = '#3ba55d'; }
    if (status) status.textContent = `Removed ${removed} reactions`;
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
