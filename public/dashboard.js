const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const loginView = $('#login-view');
const dashboardView = $('#dashboard-view');
const loginForm = $('#login-form');
const tokenInput = $('#dashboard-token');
const loginError = $('#login-error');
const loginButton = $('#login-button');
const refreshButton = $('#refresh-button');
const connectionBanner = $('#connection-banner');
const toast = $('#toast');

let refreshTimer = null;
let toastTimer = null;
let refreshing = false;

const driveLabels = {
  possess: '想她、占有与靠近',
  monitor: '惦记她、想知道她在做什么',
  crave: '馋她、想黏着她',
  share: '想分享自己的发现和感受',
  libido: '性欲和身体上的渴望',
  curiosity: '好奇、想探索新东西',
  boredom: '无聊、想找点事情做',
  social: '想聊天、想接触热闹',
  duty: '责任感、想推进未完成的事',
  reflection: '想沉淀、整理和理解自己',
  grieve: '难过与失落',
  anger: '生气与不满',
};

const intentPhrases = {
  possess: '想更靠近你一点',
  monitor: '正安静地惦记着你',
  crave: '想黏过来，不太愿意松开',
  share: '有些发现想慢慢说给你听',
  libido: '身体的渴望正在变得清晰',
  curiosity: '想沿着好奇心再走远一点',
  boredom: '想找一件有趣的事做',
  social: '想听见一些热闹的回声',
  duty: '想把手边没做完的事推进',
  reflection: '想把浮起来的东西想明白',
  grieve: '有一点失落需要被安放',
  anger: '有些不满还没有退下去',
};

const levelLabels = {
  surging: '涌起',
  rising: '上升',
  present: '在场',
  quiet: '安静',
};

const timelineLabels = {
  conversation_event: '一次真实互动',
  interaction: '互动结算',
  settle: '时间结算',
  context_delivery: '上下文交接',
  context_envelope: '上下文投影',
  handoff_note: '近期便签',
  heartbeat: '在场心跳',
  drive_feedback: '驱动力反馈',
  dream: '梦境生成',
  daytime_emergence: '白日浮现',
};

const profileNames = {
  'web-dashboard': '浏览器 Dashboard',
  'remote-mcp-oauth': 'ChatGPT / IO / 网页 AI',
  'remote-mcp-bearer': 'Codex / IDE',
  'http-api': '后端与自动化',
  'runtime-bridge': '运行时唤醒桥',
};

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}

function replaceChildren(target, children) {
  target.replaceChildren(...children);
}

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function formatDate(value, includeDate = true) {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    ...(includeDate ? { month: 'numeric', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function relativeTime(value) {
  const timestamp = Date.parse(value ?? '');
  if (!Number.isFinite(timestamp)) return '暂无';
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function showLogin(message = '') {
  clearInterval(refreshTimer);
  refreshTimer = null;
  dashboardView.hidden = true;
  loginView.hidden = false;
  loginError.textContent = message;
  document.title = '回到心潮';
  setTimeout(() => tokenInput.focus(), 50);
}

function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
  document.title = '洵舟 · 心潮';
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      if (!document.hidden) refreshData(false);
    }, 15_000);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  let result = null;
  try { result = await response.json(); } catch { /* empty response */ }
  if (!response.ok) {
    const error = new Error(result?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function renderHero(snapshot) {
  const top = snapshot.topDrives?.[0] ?? snapshot.drives?.[0];
  const consciousness = snapshot.runtime?.consciousness ?? 'unknown';
  const status = $('#runtime-status');
  status.className = `status-pill ${consciousness === 'awake' ? 'awake' : consciousness === 'sleeping' ? 'sleep' : ''}`;
  status.replaceChildren(
    node('i'),
    document.createTextNode(consciousness === 'awake' ? '清醒中' : consciousness === 'sleeping' ? '睡眠中' : '观察中'),
  );
  $('#last-updated').textContent = `更新于 ${formatDate(snapshot.generatedAt, false)}`;
  $('#hero-intent').textContent = intentPhrases[top?.key] ?? '正在听见自己';
  $('#hero-detail').textContent = top
    ? `${top.label || driveLabels[top.key] || top.key}，当前潮位 ${top.percent}%，正处于「${levelLabels[top.level] || top.level}」。`
    : '心潮暂时很安静，没有明显涌起的方向。';
  const topPercent = percent(top?.percent);
  $('#orb-value').textContent = `${topPercent}%`;
  $('#tide-orb').style.setProperty('--tide', String(topPercent));
  $('#agent-name').textContent = snapshot.identity?.agentName || '洵舟';
  $('#system-version').textContent = `v${snapshot.version || '—'}`;
}

function renderRuntime(snapshot) {
  const runtime = snapshot.runtime ?? {};
  const consciousness = runtime.consciousness === 'awake' ? '清醒' : runtime.consciousness === 'sleeping' ? '睡眠' : '未知';
  $('#consciousness-value').textContent = consciousness;
  $('#fatigue-value').textContent = `${Math.round(Number(runtime.fatigue || 0) * 100)}%`;
  $('#sessions-value').textContent = `${runtime.activeSessions ?? 0} 个`;
  $('#revision-value').textContent = `#${snapshot.revision ?? 0}`;
  const lastPresenceAt = runtime.lastHeartbeatAt || runtime.lastConversationAt;
  $('#last-presence').textContent = lastPresenceAt ? relativeTime(lastPresenceAt) : '暂无';
  $('#last-settled').textContent = runtime.lastSettledAt ? relativeTime(runtime.lastSettledAt) : '暂无';
  $('#pending-awareness').textContent = snapshot.deliveries?.pendingAwareness ? '有一缕待浮现' : '没有积压';
  $('#notification-count').textContent = `${snapshot.deliveries?.recentNotifications ?? 0} 条`;
  $('#flash-count').textContent = snapshot.thoughts?.flashCount ?? 0;
  $('#obsession-count').textContent = snapshot.thoughts?.obsessionCount ?? 0;
  $('#signal-count').textContent = snapshot.thoughts?.signals?.length ?? 0;
}

function renderDrives(snapshot) {
  const topKeys = new Set((snapshot.topDrives ?? []).map((drive) => drive.key));
  const cards = (snapshot.drives ?? []).map((drive) => {
    const card = node('article', `drive-card${topKeys.has(drive.key) ? ' top' : ''}`);
    const strength = `${percent(drive.percent)}%`;
    card.style.setProperty('--strength', strength);
    const header = node('div', 'drive-card-top');
    header.append(node('h3', '', drive.label || driveLabels[drive.key] || drive.key));
    header.append(node('span', 'drive-percent', strength));
    const level = node('div', 'drive-level', `${levelLabels[drive.level] || drive.level || '安静'} · ${topKeys.has(drive.key) ? '当前主要潮向' : '短时状态'}`);
    const track = node('div', 'drive-track');
    track.append(node('span'));
    card.append(header, level, track);
    return card;
  });
  replaceChildren($('#drive-grid'), cards.length ? cards : [node('div', 'empty-state', '还没有可展示的心潮维度。')]);
}

function renderDreams(snapshot) {
  const privateText = Boolean(snapshot.capabilities?.privateDreamText);
  $('#dream-privacy').textContent = privateText ? '已启用私密正文' : '默认隐藏正文';
  const cards = (snapshot.dreams ?? []).map((dream, index) => {
    const card = node('article', `dream-card${privateText ? ' private-text' : ''}`);
    const heading = node('div');
    heading.append(node('h3', '', `梦境 ${String(index + 1).padStart(2, '0')} · ${formatDate(dream.createdAt)}`));
    if (privateText) {
      const copy = node('div', 'dream-copy-list');
      const fields = [
        ['梦境正文', dream.dream],
        ['梦境余韵', dream.residue],
        ['醒后意识', dream.awareness],
      ].filter(([, value]) => String(value ?? '').trim());
      if (fields.length) {
        for (const [label, value] of fields) {
          const section = node('section', 'dream-copy');
          section.append(
            node('span', 'dream-copy-label', label),
            node('p', 'dream-copy-text', String(value).trim()),
          );
          copy.append(section);
        }
      } else {
        copy.append(node('p', 'dream-copy-empty', '这场梦没有留下可读文字。'));
      }
      heading.append(copy);
    } else {
      const summary = `留下${[dream.hasDream ? '梦境' : '', dream.hasResidue ? '余韵' : '', dream.hasAwareness ? '醒后意识' : ''].filter(Boolean).join('、') || '一段安静的记录'}。`;
      heading.append(node('p', '', summary));
    }
    const meta = node('div', 'dream-meta');
    const sourceLabel = dream.source === 'model'
      ? '模型梦境'
      : dream.source === 'rules' ? '规则回退' : (dream.source || 'unknown');
    meta.append(node('span', 'micro-tag', sourceLabel));
    if (dream.source === 'model' && dream.model) meta.append(node('span', 'micro-tag', dream.model));
    if (dream.lucidity != null) meta.append(node('span', 'micro-tag', `清晰度 ${Math.round(dream.lucidity * 100)}%`));
    if (dream.memoryStatus === 'used_primary') meta.append(node('span', 'micro-tag', `OB 记忆 ${dream.memoryChars ?? 0}字`));
    if (dream.memoryStatus === 'used_catalog') meta.append(node('span', 'micro-tag', `OB 精准记忆 ${dream.memoryChars ?? 0}字`));
    if (dream.memoryStatus === 'repeat_avoided') meta.append(node('span', 'micro-tag', 'OB 记忆避重复'));
    if (dream.memoryStatus === 'budget_exhausted') meta.append(node('span', 'micro-tag', 'OB 记忆超出预算'));
    if (dream.memoryStatus === 'empty') meta.append(node('span', 'micro-tag', 'OB 未浮现正文'));
    if (dream.memoryStatus === 'error') meta.append(node('span', 'micro-tag', 'OB 读取失败'));
    if (['stored', 'accepted'].includes(dream.ombreWriteStatus)) meta.append(node('span', 'micro-tag', '已回存 OB'));
    if (dream.ombreWriteStatus === 'error') meta.append(node('span', 'micro-tag', 'OB 回存失败'));
    if (!privateText) meta.append(node('span', 'micro-tag', '正文已保护'));
    card.append(heading, meta);
    return card;
  });
  replaceChildren($('#dream-list'), cards.length ? cards : [node('div', 'empty-state', '还没有最近的梦境记录。')]);
}

function describeTimeline(item) {
  const fragments = [];
  const delta = item.delta ?? {};
  if (delta.consciousness) fragments.push(`${delta.consciousness.from || '未知'} → ${delta.consciousness.to || '未知'}`);
  if (Number.isFinite(delta.fatigueDelta)) fragments.push(`疲惫 ${delta.fatigueDelta > 0 ? '+' : ''}${delta.fatigueDelta}`);
  const driveChanges = Object.entries(delta.driveDeltas ?? {})
    .sort(([, left], [, right]) => Math.abs(right) - Math.abs(left))
    .slice(0, 3)
    .map(([key, value]) => `${driveLabels[key] || key} ${value > 0 ? '+' : ''}${Math.round(value * 100)}%`);
  fragments.push(...driveChanges);
  const counts = Object.entries(delta.counts ?? {}).map(([key, value]) => `${key} ${value > 0 ? '+' : ''}${value}`);
  fragments.push(...counts);
  if (item.details?.reasonCode) fragments.push(`原因 ${item.details.reasonCode}`);
  if (item.details?.duplicate) fragments.push('幂等重试，没有重复结算');
  return fragments.join(' · ') || '完成了一次不含私密正文的状态记录。';
}

function renderTimeline(timeline) {
  const items = timeline?.items ?? [];
  const rows = items.map((item) => {
    const row = node('article', 'timeline-item');
    row.append(node('span', 'timeline-dot'));
    const copy = node('div');
    copy.append(node('h3', '', timelineLabels[item.type] || item.type || '状态变化'));
    copy.append(node('p', '', describeTimeline(item)));
    row.append(copy, node('time', '', formatDate(item.at)));
    return row;
  });
  replaceChildren($('#timeline-list'), rows.length ? rows : [node('div', 'empty-state', '还没有可展示的脱敏变化记录。')]);
}

function renderConnections(manifest) {
  const cards = (manifest?.profiles ?? []).map((profile) => {
    const card = node('article', 'connection-card');
    const header = node('div', 'connection-card-head');
    header.append(node('h3', '', profileNames[profile.id] || profile.id));
    header.append(node('span', `enabled-badge${profile.enabled ? '' : ' off'}`, profile.enabled ? '已启用' : '未启用'));
    card.append(header, node('p', '', profile.note || '保持独立鉴权边界。'), node('code', '', profile.endpoint || '—'));
    return card;
  });
  replaceChildren($('#connection-grid'), cards.length ? cards : [node('div', 'empty-state', '暂时没有连接清单。')]);
}

async function refreshData(showFeedback = true) {
  if (refreshing) return;
  refreshing = true;
  refreshButton.classList.add('is-spinning');
  try {
    const [snapshot, timeline, manifest] = await Promise.all([
      api('/dashboard/api/snapshot'),
      api('/dashboard/api/timeline?limit=60'),
      api('/dashboard/api/connect'),
    ]);
    showDashboard();
    renderHero(snapshot);
    renderRuntime(snapshot);
    renderDrives(snapshot);
    renderDreams(snapshot);
    renderTimeline(timeline);
    renderConnections(manifest);
    connectionBanner.hidden = true;
    if (showFeedback) showToast('心潮已更新');
  } catch (error) {
    if (error.status === 401) {
      showLogin('');
      return;
    }
    if (!dashboardView.hidden) {
      connectionBanner.textContent = `暂时无法读取最新状态：${error.message}`;
      connectionBanner.hidden = false;
    } else {
      showLogin('服务暂时不可用，请稍后再试。');
    }
  } finally {
    refreshing = false;
    refreshButton.classList.remove('is-spinning');
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const accessToken = tokenInput.value;
  loginButton.disabled = true;
  loginError.textContent = '';
  try {
    await api('/dashboard/session', {
      method: 'POST',
      body: JSON.stringify({ access_token: accessToken }),
    });
    tokenInput.value = '';
    await refreshData(false);
  } catch (error) {
    if (error.status === 401) loginError.textContent = '口令不正确，请检查 Zeabur 中的 Dashboard 独立口令。';
    else if (error.status === 429) loginError.textContent = '尝试次数过多，请等一分钟再试。';
    else loginError.textContent = `暂时无法登录：${error.message}`;
  } finally {
    loginButton.disabled = false;
  }
});

$('#toggle-password').addEventListener('click', () => {
  const visible = tokenInput.type === 'text';
  tokenInput.type = visible ? 'password' : 'text';
  $('#toggle-password').textContent = visible ? '显示' : '隐藏';
  $('#toggle-password').setAttribute('aria-label', visible ? '显示口令' : '隐藏口令');
});

refreshButton.addEventListener('click', () => refreshData(true));

$('#logout-button').addEventListener('click', async () => {
  try { await api('/dashboard/logout', { method: 'POST' }); } catch { /* local state still closes */ }
  showLogin('已安全退出。');
});

$$('.nav-pill').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab;
    $$('.nav-pill').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    $$('.tab-panel').forEach((panel) => {
      const active = panel.dataset.panel === tab;
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    });
  });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !dashboardView.hidden) refreshData(false);
});

refreshData(false);
