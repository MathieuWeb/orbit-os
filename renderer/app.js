/* AI Terminal renderer: plain JS, no framework. `api` is the global from preload.js. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || '~';
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const timeStr = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Original simple icons (not company logos).
const ICONS = {
  claude: '<svg viewBox="0 0 24 24"><path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/></svg>',
  codex: '<svg viewBox="0 0 24 24"><path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z"/><path d="M10 9.5L7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5"/></svg>',
  gemini: '<svg viewBox="0 0 24 24"><path d="M12 3c0 5 4 9 9 9-5 0-9 4-9 9 0-5-4-9-9-9 5 0 9-4 9-9z"/></svg>',
  ollama: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/><circle cx="12" cy="12" r="2"/></svg>',
  shell: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-6.5 8 6.5M6 9.5V19h12V9.5"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2.5-6 5 12 2.5-6h4"/></svg>',
};
const DESC = { claude: 'Anthropic coding agent', codex: 'OpenAI coding agent', gemini: 'Google agent (Gemini)', ollama: 'Free model on your Mac', shell: 'Your normal zsh' };
const INSTALL = {
  claude: { title: 'Claude Code is not installed', steps: ['curl -fsSL https://claude.ai/install.sh | bash'], after: 'Then open a Claude Code tab and follow the login steps.', url: 'https://docs.claude.com/en/docs/claude-code/setup' },
  codex: { title: 'Codex is not installed', steps: ['npm install -g @openai/codex'], after: 'Then open a Codex tab and sign in with your ChatGPT account.', url: 'https://github.com/openai/codex' },
  gemini: { title: 'Antigravity CLI is not installed', steps: ['curl -fsSL https://antigravity.google/cli/install.sh | bash'], after: 'Then open an Antigravity tab: it opens your browser to sign in with your Google account.', url: 'https://antigravity.google' },
  ollama: { title: 'Ollama is not installed', steps: [], after: 'Download the Ollama app, drag it to Applications and open it once. It runs quietly in the menu bar.', url: 'https://ollama.com/download' },
};

const S = {
  settings: null, presets: {}, lastAi: {}, favorites: [],
  tabs: [], active: 'home', pair: null,
  projects: { exists: true, projects: [], dir: '' },
  tools: { installed: {}, ollama: { running: false, models: [], loaded: [] } },
  logs: null, usage: { claude: null, codex: null, gemini: null }, live: { claude: null, codex: null, gemini: null }, loading: {}, activityTool: 'claude', search: '',
};
let uid = 0;
const byPty = new Map();

/* ---------- terminal theme ---------- */
function termTheme(a = S.settings.accent) {
  return {
    background: '#09090b', foreground: '#e4e2e8', cursor: a, cursorAccent: '#060607',
    selectionBackground: a + '44', selectionForeground: '#ffffff',
    black: '#0b0f19', red: '#ff5c7a', green: '#3ee6a0', yellow: '#ffd166', blue: '#5aa9ff', magenta: '#b18cff', cyan: '#22d3ee', white: '#c8d3e6',
    brightBlack: '#56627a', brightRed: '#ff8098', brightGreen: '#6ff2bb', brightYellow: '#ffe08f', brightBlue: '#86c1ff', brightMagenta: '#caa9ff', brightCyan: '#67e8f9', brightWhite: '#f5f8ff',
  };
}

/* ---------- tabs ---------- */
function installed(preset) { const bin = S.presets[preset]?.bin; return !bin || !!S.tools.installed[bin]; }

async function openTab({ preset, cwd, project = null, model = null, pull = null, beside = false, quiet = false }) {
  if (!installed(preset) || (pull && !S.tools.installed.ollama)) return showInstall(pull ? 'ollama' : preset);
  if (preset === 'ollama' && !pull && !(model || S.settings.defaultModel)) {
    toast('Choose a local model first');
    return openFinder();
  }
  const tab = { uid: ++uid, preset, cwd, project, model: model || (preset === 'ollama' ? S.settings.defaultModel : null), pull, exited: false };
  const pane = document.createElement('section');
  pane.className = 'pane';
  pane.innerHTML = `<div class="pane-head">${ICONS[preset]}<span class="path"></span><span class="badge"></span></div><div class="term"></div>`;
  $('#stage').appendChild(pane);
  tab.el = pane;
  tab.term = new Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2,
    cursorBlink: !reduceMotion, cursorStyle: 'block', scrollback: 5000, allowProposedApi: true,
    macOptionClickForcesSelection: true, theme: termTheme(),
  });
  tab.fit = new FitAddon.FitAddon();
  tab.term.loadAddon(tab.fit);
  tab.term.open($('.term', pane));
  tab.term.attachCustomKeyEventHandler((e) => !(e.metaKey && /^[tw1-9d]$/i.test(e.key))); // app shortcuts
  pane.addEventListener('mousedown', () => { if (S.active !== tab.uid) activate(tab.uid); });
  S.tabs.push(tab);
  if (beside && typeof S.active === 'number') S.pair = [S.active, tab.uid];
  activate(tab.uid);
  try { tab.fit.fit(); } catch {} // spawn at the real size so the shell doesn't reflow on start
  try {
    const { id, cwd: real } = await api.spawn({ preset, cwd, model: tab.model, pull, cols: tab.term.cols, rows: tab.term.rows });
    tab.pty = id; tab.cwd = real;
    byPty.set(id, tab);
  } catch (e) {
    closeTab(tab.uid, true);
    if (!quiet) toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return;
  }
  tab.term.onData((d) => {
    if (tab.exited) return closeTab(tab.uid);
    api.write(tab.pty, d);
  });
  tab.term.onResize(({ cols, rows }) => api.resize(tab.pty, cols, rows));
  let raf;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => pane.classList.contains('visible') && tab.fit.fit()); }).observe($('.term', pane));
  $('.path', pane).textContent = tab.cwd;
  $('.badge', pane).textContent = pull ? 'installing ' + pull : preset === 'ollama' ? tab.model : S.presets[preset].label;
  if (project && !pull) { S.lastAi[project] = preset; api.setState('lastAi', S.lastAi); }
  saveTabs(); renderTabs(); renderProjects(); renderModels();
}

function closeTab(id, silent) {
  const i = S.tabs.findIndex((t) => t.uid === id);
  if (i < 0) return;
  const [tab] = S.tabs.splice(i, 1);
  if (tab.pty) { api.kill(tab.pty); byPty.delete(tab.pty); }
  tab.term.dispose(); tab.el.remove();
  if (S.pair && S.pair.includes(id)) S.pair = null;
  if (S.active === id) S.active = S.tabs[Math.min(i, S.tabs.length - 1)]?.uid ?? 'home';
  if (!silent) saveTabs();
  layout(); renderTabs(); renderProjects(); renderModels();
}

function activate(id) { S.active = id; if (id !== 'home') setView('term'); else layout(); renderTabs(); }

function setView(v) {
  document.body.dataset.view = v;
  $('#crumb').textContent = v === 'dash' ? 'Dashboard' : (S.tabs.find((t) => t.uid === S.active) ? tabLabel(S.tabs.find((t) => t.uid === S.active)) : 'Terminals');
  document.querySelectorAll('.nav-item[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  layout();
}
document.querySelectorAll('.nav-item[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

function layout() {
  const show = S.pair && S.pair.includes(S.active) ? S.pair : [S.active];
  $('#emptyStage').style.display = S.tabs.some((t) => show.includes(t.uid)) ? 'none' : '';
  for (const t of S.tabs) {
    const v = show.includes(t.uid);
    t.el.classList.toggle('visible', v);
    t.el.classList.toggle('focused', v && show.length > 1 && t.uid === S.active);
    t.el.style.order = show.indexOf(t.uid);
  }
  $('#splitBtn').classList.toggle('on', !!S.pair);
  requestAnimationFrame(() => {
    for (const t of S.tabs) if (show.includes(t.uid)) { try { t.fit.fit(); } catch {} }
    const cur = S.tabs.find((t) => t.uid === S.active);
    if (cur && $('#modal').hidden && document.body.dataset.view === 'term') cur.term.focus();
  });
}

function tabLabel(t) { return t.pull ? 'Install ' + t.pull.split(':').pop() : (t.project || base(t.cwd)); }

function renderTabs() {
  $('#tabCount').textContent = S.tabs.length || '';
  if (document.body.dataset.view === 'term') $('#crumb').textContent = S.tabs.find((t) => t.uid === S.active) ? tabLabel(S.tabs.find((t) => t.uid === S.active)) : 'Terminals';
  $('#tabs').innerHTML = S.tabs.map((t, i) => `
    <div class="tab ${t.uid === S.active ? 'active' : ''} ${S.pair?.includes(t.uid) ? 'split' : ''} ${t.exited ? 'exited' : ''}" data-id="${t.uid}" role="tab" title="${esc(S.presets[t.preset].label)} · ${esc(t.cwd || '')}${i < 9 ? ' (Cmd+' + (i + 1) + ')' : ''}">
      ${ICONS[t.preset]}<span class="label">${esc(tabLabel(t))}</span><button class="x" data-close="${t.uid}" aria-label="Close tab">×</button>
    </div>`).join('');
  $('#topStatus').dataset.tabs = S.tabs.length;
}
$('#tabs').addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) return closeTab(Number(c.dataset.close));
  const t = e.target.closest('[data-id]');
  if (t) activate(t.dataset.id === 'home' ? 'home' : Number(t.dataset.id));
});
$('#tabs').addEventListener('auxclick', (e) => { const t = e.target.closest('[data-id]'); if (e.button === 1 && t && t.dataset.id !== 'home') closeTab(Number(t.dataset.id)); });

function saveTabs() {
  api.setState('tabs', S.tabs.filter((t) => !t.pull).map((t) => ({ preset: t.preset, cwd: t.cwd, project: t.project, model: t.model })));
}

api.onData((id, d) => byPty.get(id)?.term.write(d));
api.onExit((id) => {
  const t = byPty.get(id);
  if (!t) return;
  t.exited = true;
  t.term.write('\r\n\x1b[2m[Session ended. Press any key to close this tab.]\x1b[0m');
  renderTabs(); renderModels();
});
api.onDefaultModel((m) => {
  S.settings.defaultModel = m;
  toast(m + ' installed and set as your local model');
  refreshTools();
});

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) return closeModal();
  if (!e.metaKey || e.altKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 't') { e.preventDefault(); openLauncher(currentProject()); }
  else if (k === 'w') { e.preventDefault(); if (!$('#modal').hidden) closeModal(); else if (typeof S.active === 'number') closeTab(S.active); }
  else if (k === 'd') { e.preventDefault(); toggleSplit(); }
  else if (/^[1-9]$/.test(k)) { e.preventDefault(); const t = S.tabs[Number(k) - 1]; if (t) activate(t.uid); }
}, true);

function currentProject() {
  const t = S.tabs.find((x) => x.uid === S.active);
  return t && t.project ? S.projects.projects.find((p) => p.name === t.project) || null : null;
}

function toggleSplit() {
  if (S.pair) { S.pair = null; layout(); renderTabs(); return; }
  const cur = S.tabs.find((t) => t.uid === S.active);
  if (!cur) return toast('Open a terminal first, then split it');
  // Prefer pairing with an existing tab on the same project; otherwise launch a second AI there.
  openLauncher(currentProject() || { name: cur.project || base(cur.cwd), path: cur.cwd }, true);
}
$('#splitBtn').onclick = toggleSplit;
$('#newBtn').onclick = $('#navNew').onclick = () => openLauncher(currentProject());
$('#navFinder').onclick = () => openFinder();
$('#navFree').onclick = () => openFreeRam();
$('#projToggle').onclick = () => { $('#projPanel').classList.toggle('collapsed'); layout(); };

/* ---------- projects sidebar ---------- */
function renderProjects() {
  const el = $('#projList'), p = S.projects;
  $('#projCount').textContent = p.exists ? p.projects.length : '';
  if (!p.exists) {
    el.innerHTML = `<li class="empty"><div><p>No projects folder yet at <b>${esc(S.settings.projectsRoot)}</b>.</p><button class="btn primary" id="createRoot">Create it</button></div></li>`;
    $('#createRoot').onclick = () => api.createRoot();
    return;
  }
  const q = S.search.toLowerCase();
  const open = new Set(S.tabs.map((t) => t.project));
  const list = p.projects.filter((x) => x.name.toLowerCase().includes(q))
    .sort((a, b) => S.favorites.includes(b.name) - S.favorites.includes(a.name));
  el.innerHTML = list.length ? list.map((x) => {
    const fav = S.favorites.includes(x.name), last = S.lastAi[x.name];
    return `<li class="${open.has(x.name) ? 'open' : ''}">
      <button class="proj-btn" data-name="${esc(x.name)}" title="${esc(x.path)}"><span class="folder"></span><span class="name">${esc(x.name)}</span>${last ? `<span class="ai" title="Last used: ${esc(S.presets[last]?.label)}">${ICONS[last] || ''}</span>` : ''}</button>
      <button class="star ${fav ? 'on' : ''}" data-star="${esc(x.name)}" aria-label="${fav ? 'Unpin' : 'Pin'} ${esc(x.name)}" title="${fav ? 'Unpin' : 'Pin as favorite'}">${fav ? '★' : '☆'}</button>
    </li>`;
  }).join('') : `<li class="empty">${q ? 'No project matches.' : 'This folder is empty. Create a subfolder and it shows up here.'}</li>`;
}
$('#projList').addEventListener('click', (e) => {
  const s = e.target.closest('[data-star]');
  if (s) {
    const n = s.dataset.star;
    S.favorites = S.favorites.includes(n) ? S.favorites.filter((f) => f !== n) : [...S.favorites, n];
    api.setState('favorites', S.favorites);
    renderProjects(); renderHome();
    return;
  }
  const b = e.target.closest('[data-name]');
  if (b) openLauncher(S.projects.projects.find((p) => p.name === b.dataset.name));
});
$('#projSearch').addEventListener('input', (e) => { S.search = e.target.value; renderProjects(); });
api.onProjects((l) => { S.projects = l; renderProjects(); renderHome(); });

/* ---------- launcher ---------- */
function openLauncher(project, beside = false) {
  const last = project && S.lastAi[project.name];
  const cwd = project ? project.path : S.projects.exists ? S.projects.dir : null;
  const order = ['claude', 'codex', 'gemini', 'ollama', 'shell'];
  const sub = (k) => {
    if (!installed(k)) return 'Not installed: click for steps';
    if (k === 'ollama') return S.settings.defaultModel ? esc(S.settings.defaultModel) + (S.tools.ollama.running ? '' : ' · open the Ollama app first') : 'No model yet: find one';
    return DESC[k];
  };
  showModal(`
    <h2>${beside ? 'Split view: open beside' : 'Open with'}</h2>
    <h1>${esc(project ? project.name : 'New terminal')}</h1>
    <p class="muted small" style="margin:-10px 0 16px">${esc(cwd || '~')}</p>
    <div class="launch-grid">${order.map((k) => `
      <button data-preset="${k}" class="${k === last ? 'last' : ''} ${installed(k) ? '' : 'off'}">${ICONS[k]}
        <span><div class="t">${esc(S.presets[k].label)}${k === last ? ' <span class="pill">last used</span>' : ''}</div><div class="s">${sub(k)}</div></span>
      </button>`).join('')}
    </div>
    ${beside && S.tabs.length > 1 ? `<p class="small muted" style="margin-top:14px">Or show an open tab beside this one: ${S.tabs.filter((t) => t.uid !== S.active).map((t) => `<button class="link-btn" data-pair="${t.uid}">${esc(tabLabel(t))}</button>`).join(' · ')}</p>` : ''}
    <div class="modal-foot"><span class="small muted" style="margin-right:auto">Press 1-4 to choose</span><button class="btn" data-close>Cancel</button></div>`);
  const go = (k) => { closeModal(); openTab({ preset: k, cwd, project: project ? project.name : null, beside }); };
  $('#modalBody').querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => go(b.dataset.preset)));
  $('#modalBody').querySelectorAll('[data-pair]').forEach((b) => (b.onclick = () => { S.pair = [S.active, Number(b.dataset.pair)]; closeModal(); layout(); renderTabs(); }));
  $('#modalBody').onkeydown = (e) => { const i = '1234'.indexOf(e.key); if (i >= 0 && !e.metaKey) go(order[i]); };
  $('#modalBody [data-preset]').focus();
}

/* ---------- modal + toast ---------- */
function showModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
  $('#modalBody').querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modalBody').onkeydown = null;
  S.tabs.find((t) => t.uid === S.active)?.term.focus();
}
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }

function showInstall(tool) {
  const i = INSTALL[tool];
  showModal(`<h2>Setup needed</h2><h1>${esc(i.title)}</h1>
    ${i.steps.length ? '<p class="muted">Paste this in a Plain terminal tab:</p>' + i.steps.map((s) => `<code class="code">${esc(s)}</code>`).join('') : ''}
    <p class="muted">${esc(i.after)}</p>
    <div class="modal-foot"><button class="btn" data-close>Close</button>${i.steps.length ? '<button class="btn" id="runInstall">Open a terminal with this</button>' : ''}<button class="btn primary" id="openSite">Open website</button></div>`);
  $('#openSite').onclick = () => api.openUrl(i.url);
  const r = $('#runInstall');
  if (r) r.onclick = async () => {
    closeModal();
    await openTab({ preset: 'shell', cwd: null });
    const t = S.tabs[S.tabs.length - 1];
    // Typed but not run: you press Enter yourself.
    setTimeout(() => t && api.write(t.pty, i.steps[0]), 800);
  };
}

/* ---------- models sidebar ---------- */
function toolState(k) {
  const bin = S.presets[k].bin;
  if (!S.tools.installed[bin]) return 'missing';
  const live = S.tabs.some((t) => t.preset === k && !t.exited && !t.pull) || (k === 'ollama' && S.tools.ollama.loaded.length);
  return live ? 'running' : 'installed';
}
function renderModels() {
  const label = { missing: 'Not installed', installed: 'Installed', running: 'Running' };
  $('#modelCards').innerHTML = ['claude', 'codex', 'gemini', 'ollama'].map((k) => {
    const st = toolState(k);
    let s = label[st];
    if (k === 'ollama' && st !== 'missing') s += S.tools.ollama.running ? ` · ${S.tools.ollama.models.length} model${S.tools.ollama.models.length === 1 ? '' : 's'}` : ' · app not open';
    return `<div class="model-card"><span class="ico">${ICONS[k]}</span><div class="meta"><div class="t">${esc(S.presets[k].label)}</div><div class="s">${s}</div>
      ${st === 'missing' ? `<button class="help" data-install="${k}">How to install</button>` : ''}</div><span class="dot ${st}" title="${label[st]}"></span></div>`;
  }).join('');
  const o = S.tools.ollama;
  $('#ollamaList').innerHTML = !S.tools.installed.ollama ? '<li class="na">Ollama not installed</li>'
    : !o.running ? '<li class="na">Open the Ollama app to see models</li>'
    : o.models.length ? o.models.map((m) => `<li data-model="${esc(m.name)}" class="${m.name === S.settings.defaultModel ? 'default' : ''}" title="Click to make this the default local model"><span>${esc(m.name)}</span><span>${m.sizeGB} GB</span></li>`).join('')
    : '<li class="na">No models yet: use Find best local model</li>';
}
$('#ollamaList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-model]');
  if (!li) return;
  S.settings.defaultModel = li.dataset.model;
  api.setState('settings', S.settings);
  toast(li.dataset.model + ' is now the default local model');
  renderModels(); renderLocal();
});
$('#toolsRefresh').onclick = () => refreshTools(true);

async function refreshTools(announce) {
  S.tools = await api.tools();
  renderModels(); renderLocal(); Object.keys(USAGE).forEach(renderUsage);
  if (announce) toast('Tools checked');
}

/* ---------- usage cards ---------- */
const USAGE = {
  claude: { el: '#usageClaude', name: 'Claude Code', cmd: '/usage' },
  codex: { el: '#usageCodex', name: 'Codex', cmd: '/status' },
  gemini: { el: '#usageGemini', name: 'Antigravity', cmd: '/usage' },
};
// Newest of live (API) and captured data for a tool.
function usageOf(tool) { const c = S.usage[tool], l = S.live[tool]; return l && (!c || l.at >= c.at) ? l : c; }
// The 5 h session limit (headline) and the all-models weekly limit (shown under it).
function pickLimits(items) {
  const week = items.find((m) => /week/i.test(m.label) && !/opus|sonnet|fable/i.test(m.label));
  const session = items.find((m) => m !== week && /session|5 ?h|hour/i.test(m.label)) || items.find((m) => m !== week);
  return { session, week };
}
function renderUsage(tool) {
  const { el: sel, name, cmd } = USAGE[tool], el = $(sel);
  const u = usageOf(tool), loading = S.loading[tool];
  const items = (u && u.items) || [];
  const { session, week } = pickLimits(items);
  const main = session || week;
  let status;
  if (!S.tools.installed[tool]) status = `Not installed. <button class="link-btn" data-install="${tool}">How to install</button>`;
  else if (loading) status = `Reading <code>${cmd}</code> in the background… (about 10 s)`;
  else if (!u) status = `Press Refresh to read <code>${cmd}</code>.`;
  else if (u.error) status = esc(u.error === 'not installed' ? 'Not available' : u.error);
  else status = u.live ? `<span class="live-dot"></span>Live · ${timeStr(u.at)}` : `Refreshed ${timeStr(u.at)}`;
  const under = main !== week ? week : null;
  const meters = items.filter((m) => m !== main && m !== under).map((m) => `<div class="meter"><div class="meter-top"><span>${esc(m.label)}</span><b>${m.percentUsed}%</b></div>
    <div class="bar ${m.percentUsed >= 80 ? 'hot' : ''}"><i data-w="${m.percentUsed}"></i></div>${m.resets ? `<div class="reset">Resets ${esc(m.resets)}</div>` : ''}</div>`).join('');
  const pct = main ? main.percentUsed : null;
  el.innerHTML = `<div class="orb ${tool} ${pct >= 80 ? 'hot' : ''}"><i style="height:${pct == null ? 0 : Math.max(6, pct)}%"></i><span class="orb-ico">${ICONS[tool]}</span></div>
    <div class="orb-meta">
      <div class="big">${pct == null ? '–' : pct}<small>%</small></div>
      <div class="lbl"><span class="dotc"></span>${name}, ${main && main === week ? 'weekly' : '5 h limit'}</div>
      ${main && main.resets ? `<div class="reset">Resets ${esc(main.resets)}</div>` : ''}
      ${under ? `<div class="week"><div class="meter-top"><span>Weekly</span><b>${under.percentUsed}%</b></div><div class="bar ${under.percentUsed >= 80 ? 'hot' : ''}"><i data-w="${under.percentUsed}"></i></div>${under.resets ? `<div class="reset">Resets ${esc(under.resets)}</div>` : ''}</div>` : ''}
      <div class="reset">${status}</div>
      ${S.tools.installed[tool] ? `<div class="orb-actions"><button class="chip" data-refresh="${tool}" ${loading ? 'disabled' : ''}>${loading ? 'Reading…' : 'Refresh'}</button>
        ${meters || (u && u.text) ? `<details><summary>Details</summary>${meters}${u && u.text ? `<pre class="raw">${esc(u.text)}</pre>` : ''}</details>` : ''}</div>` : ''}
    </div>`;
  requestAnimationFrame(() => el.querySelectorAll('.bar i[data-w]').forEach((i) => (i.style.width = i.dataset.w + '%')));
  renderUsageWidget();
}
// Left-nav usage summary (shown in Terminals): 5 h bar + weekly for every installed tool.
function renderUsageWidget() {
  const rows = Object.keys(USAGE).filter((t) => S.tools.installed[t]).map((t) => {
    const { session, week } = pickLimits((usageOf(t) || {}).items || []), main = session || week;
    const pct = main ? main.percentUsed : null;
    return `<div class="u-row"><div class="w-row"><span>${esc(USAGE[t].name)}</span><b>${pct == null ? '–' : pct + '%'}</b></div>
      <div class="bar ${pct >= 80 ? 'hot' : ''}"><i style="width:${pct || 0}%"></i></div>
      <div class="u-week">${main && main !== week && week ? `Weekly ${week.percentUsed}%` : main === week && main ? 'Weekly' : 'No data yet'}</div></div>`;
  }).join('');
  $('#usageWidget').innerHTML = `<div class="w-head">Usage <span>5 h · weekly</span></div>${rows || '<div class="u-week">No AI tool installed</div>'}`;
}
$('#dashboard').addEventListener('click', async (e) => {
  const i = e.target.closest('[data-install]');
  if (i) return showInstall(i.dataset.install);
  const r = e.target.closest('[data-refresh]');
  if (r) {
    const tool = r.dataset.refresh;
    S.loading[tool] = true; renderUsage(tool);
    S.usage[tool] = await api.capture(tool);
    S.loading[tool] = false; renderUsage(tool);
  }
  const seg = e.target.closest('[data-act]');
  if (seg) { S.activityTool = seg.dataset.act; renderActivity(); }
  if (e.target.closest('#findModel')) openFinder();
  if (e.target.closest('#freeRam')) openFreeRam();
});

/* ---------- local activity (session logs) ---------- */
function renderActivity() {
  const tool = S.activityTool, s = S.logs && S.logs[tool];
  const head = `<div class="card-head">${ICONS.pulse}<h2>Activity</h2><div class="seg"><button data-act="claude" class="${tool === 'claude' ? 'on' : ''}">Claude</button><button data-act="codex" class="${tool === 'codex' ? 'on' : ''}">Codex</button></div></div>`;
  if (!s) return ($('#activity').innerHTML = head + '<p class="muted small">Reading local session logs…</p>');
  if (!s.available) return ($('#activity').innerHTML = head + '<p class="na">Not available: no local session logs from the last 7 days.</p>');
  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 6 + i); return d; });
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const vals = days.map((d) => s.days[key(d)] || 0), max = Math.max(...vals, 1);
  const W = 280, H = 96, bw = 26, gap = (W - bw * 7) / 6;
  const bars = vals.map((v, i) => {
    const h = Math.max(2, (v / max) * (H - 26)), x = i * (bw + gap);
    return `<rect x="${x}" y="${H - 14 - h}" width="${bw}" height="${h}" rx="3" fill="url(#barGrad)" opacity="${i === 6 ? 1 : .6}"><title>${fmt(v)} tokens</title></rect>
      <text x="${x + bw / 2}" y="${H - 2}" text-anchor="middle">${days[i].toLocaleDateString([], { weekday: 'narrow' })}</text>`;
  }).join('');
  const projects = Object.entries(s.projects).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const pmax = projects[0]?.[1] || 1;
  $('#activity').innerHTML = head + `
    <div class="stats"><div class="stat"><div class="v">${fmt(s.today.tokens)}</div><div class="l">tokens today · ${s.today.sessions} session${s.today.sessions === 1 ? '' : 's'}</div></div>
    <div class="stat"><div class="v">${fmt(s.week.tokens)}</div><div class="l">last 7 days · ${s.week.sessions} sessions</div></div></div>
    <svg class="chart" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--accent-2)"/></linearGradient></defs>${bars}</svg>
    <div class="sub-head" style="margin-top:6px">Per project (7 days)</div>
    ${projects.map(([n, v]) => `<div class="hbar"><span title="${esc(n)}">${esc(n)}</span><div class="bar"><i data-w="${(v / pmax) * 100}"></i></div><b>${fmt(v)}</b></div>`).join('')}
    <div class="reset" style="margin-top:6px">From local logs. Counts input + output + cache writes.</div>`;
  requestAnimationFrame(() => $('#activity').querySelectorAll('.bar i[data-w]').forEach((i) => (i.style.width = i.dataset.w + '%')));
}
async function refreshLive() {
  const r = await api.usageLive();
  for (const t of ['claude', 'codex']) {
    if (r[t] && r[t].at !== S.live[t]?.at && !S.loading[t]) { S.live[t] = r[t]; renderUsage(t); }
  }
}
// No live feed (Claude status line without rate_limits, Codex with no sessions, Gemini never):
// read each CLI's own usage screen in a hidden terminal, at most every 10 minutes, one at a time.
const AUTO_MS = 10 * 60e3;
let autoBusy = false;
async function autoCapture() {
  if (autoBusy || document.hidden) return;
  autoBusy = true;
  try {
    for (const t of Object.keys(USAGE)) {
      if (!S.tools.installed[t] || S.loading[t]) continue;
      if (Date.now() - Math.max(S.live[t]?.at || 0, S.usage[t]?.at || 0) < AUTO_MS) continue;
      S.loading[t] = true; renderUsage(t);
      S.usage[t] = await api.capture(t);
      S.loading[t] = false; renderUsage(t);
    }
  } finally { autoBusy = false; }
}
async function refreshLogs() { S.logs = await api.usageLogs(); renderActivity(); }

/* ---------- local model + system ---------- */
function renderLocal() {
  const o = S.tools.ollama, d = S.settings.defaultModel;
  const status = !S.tools.installed.ollama ? 'Not installed' : o.running ? 'Running' : 'App not open';
  const loaded = o.loaded.length ? o.loaded.map((m) => `<div class="kv"><span>${esc(m.name)}</span><span>${m.ramGB} GB RAM</span></div>`).join('') : '<div class="kv"><span>In memory</span><span class="na">none</span></div>';
  const pill = $('#modelPill');
  pill.className = 'model-pill ' + (o.running ? 'on' : '');
  pill.innerHTML = `${ICONS.ollama}<span>${o.running ? 'Local' : 'Offline'}</span><b>${d ? esc(d.split('/').pop()) : 'no model'}</b>`;
  pill.title = 'Local model: click to find the best one for this Mac';
  pill.onclick = openFinder;
  $('#localCard').innerHTML = `<div class="card-head">${ICONS.ollama}<h2>Local model</h2></div>
    <div class="kv"><span>Ollama</span><span>${status}</span></div>
    <div class="kv"><span>Default model</span><span title="${esc(d)}">${d ? esc(d) : '<span class="na">not set</span>'}</span></div>
    ${loaded}
    <button class="btn" id="findModel" style="margin-top:10px;width:100%;justify-content:center">Find best local model</button>
    ${!S.tools.installed.ollama ? '<p class="small muted" style="margin:8px 0 0">Needs Ollama. <button class="link-btn" data-install="ollama">How to install</button></p>' : ''}`;
}

function ring(pct) {
  const r = 32, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 78 78"><circle class="track" cx="39" cy="39" r="${r}"/><circle class="val" cx="39" cy="39" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}"/></svg>`;
}
function renderSystemShell() {
  $('#systemCard').innerHTML = `<div class="card-head"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/></svg><h2>System</h2><span class="small muted" id="chip"></span></div>
    <svg width="0" height="0" style="position:absolute"><defs><linearGradient id="ringGrad"><stop offset="0" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--accent-2)"/></linearGradient></defs></svg>
    <div class="rings"><div class="ring" id="ramRing">${ring(0)}<div class="num">–</div><div class="lbl">Memory</div></div><div class="ring" id="cpuRing">${ring(0)}<div class="num">–</div><div class="lbl">CPU</div></div></div>
    <div class="kv small" style="margin-top:8px"><span>Memory used</span><span id="ramText">–</span></div>
    <button class="btn primary" id="freeRam" style="margin-top:10px;width:100%;justify-content:center">Free up memory</button>`;
  $('#sysWidget').innerHTML = `<div class="w-head"><span class="live-dot"></span>This Mac</div>
    <div class="w-row"><span>Memory</span><b id="wRam">–</b></div><div class="bar"><i id="wRamBar"></i></div>
    <div class="w-row"><span>CPU</span><b id="wCpu">–</b></div><div class="bar"><i id="wCpuBar"></i></div>`;
}
function setRing(id, pct, text) {
  const el = $(id), c = 2 * Math.PI * 32;
  $('.val', el).style.strokeDashoffset = c * (1 - Math.min(100, pct) / 100);
  $('.num', el).textContent = text;
}
async function tickSystem() {
  if (document.hidden) return;
  const s = await api.system();
  const usedGB = s.used / 1024 ** 3, totGB = s.total / 1024 ** 3;
  setRing('#ramRing', (s.used / s.total) * 100, Math.round((s.used / s.total) * 100) + '%');
  setRing('#cpuRing', s.cpu, s.cpu + '%');
  $('#ramText').textContent = `${usedGB.toFixed(1)} of ${Math.round(totGB)} GB`;
  const ramPct = Math.round((s.used / s.total) * 100);
  $('#wRam').textContent = `${usedGB.toFixed(1)} GB`; $('#wRamBar').style.width = ramPct + '%';
  $('#wCpu').textContent = s.cpu + '%'; $('#wCpuBar').style.width = s.cpu + '%';
  $('#topStatus').innerHTML = `<span>RAM <b>${usedGB.toFixed(1)}/${Math.round(totGB)} GB</b></span><span>CPU <b>${s.cpu}%</b></span><span>Tabs <b>${S.tabs.length}</b></span>`;
}

/* ---------- free up memory ---------- */
async function openFreeRam() {
  showModal('<h2>Free up memory</h2><h1>Looking at open apps…</h1>');
  const [apps, tools] = await Promise.all([api.apps(), api.tools()]);
  const loaded = tools.ollama.loaded || [];
  const row = (kind, name, size, hint) => `<label class="free-row"><input type="checkbox" data-${kind}="${esc(name)}"><span>${esc(name)}${hint ? `<small>${hint}</small>` : ''}</span><b>${size}</b></label>`;
  const gb = (mb) => mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
  showModal(`<h2>Free up memory</h2><h1>Close what you don't need</h1>
    <p class="muted small" style="margin:-8px 0 14px">Apps close like with ⌘Q: if something isn't saved, the app asks first. Sizes are estimates.</p>
    ${loaded.length ? `<div class="sub-head">Local models in memory</div>${loaded.map((m) => row('model', m.name, m.ramGB + ' GB', 'Unloads it. It reloads next time you use it.')).join('')}` : ''}
    <div class="sub-head">Open apps</div>
    <div class="free-list">${apps.length ? apps.map((a) => row('app', a.name, '≈ ' + gb(a.mb))).join('') : '<p class="na">No other apps using much memory.</p>'}</div>
    <div class="modal-foot"><span class="small muted" id="freeSum" style="margin-right:auto">Nothing selected</span><button class="btn" data-close>Cancel</button><button class="btn primary" id="freeGo" disabled>Close selected</button></div>`);
  const body = $('#modalBody'), boxes = () => [...body.querySelectorAll('input:checked')];
  body.onchange = () => {
    const n = boxes().length;
    $('#freeGo').disabled = !n;
    $('#freeSum').textContent = n ? `${n} selected` : 'Nothing selected';
  };
  $('#freeGo').onclick = async () => {
    const sel = { apps: boxes().filter((b) => b.dataset.app).map((b) => b.dataset.app), models: boxes().filter((b) => b.dataset.model).map((b) => b.dataset.model) };
    const before = (await api.system()).used;
    $('#freeGo').disabled = true; $('#freeGo').textContent = 'Closing…';
    const r = await api.freeMemory(sel);
    closeModal();
    await new Promise((res) => setTimeout(res, 2500)); // let apps finish quitting before measuring
    const freed = (before - (await api.system()).used) / 1024 ** 3;
    toast((r.quit < r.asked ? `${r.asked - r.quit} app(s) did not close (maybe waiting for you to save). ` : '') + (freed > 0.05 ? `Freed about ${freed.toFixed(1)} GB` : 'Done'));
    tickSystem(); refreshTools();
  };
}

/* ---------- best local model finder ---------- */
async function openFinder() {
  showModal('<h2>Best local model</h2><h1>Checking your Mac…</h1>');
  const r = await api.finder();
  const hw = r.hw, ok = S.tools.installed.ollama;
  $('#chip').textContent = hw.chip;
  const card = (m, kind) => m ? `<div class="pick ${kind}">
      <div class="row"><span class="n">${esc(m.name)}</span><span class="pill">${kind === 'top' ? 'Best fit' : kind === 'big' ? 'Too big' : 'Runner-up'}</span></div>
      <div class="tag">${esc(m.tag)} · ${esc(m.params)} · ${esc(m.quant)} · ${m.sizeGB} GB · coding ${m.score}/10${m.verified === false ? ' · not found on last refresh' : ''}</div>
      <div class="why">${esc(m.reason)}</div>
      ${kind !== 'big' ? `<div class="row" style="justify-content:flex-start;margin-top:8px"><button class="btn ${kind === 'top' ? 'primary' : ''}" data-pull="${esc(m.tag)}">${ok ? 'Install' : 'Install (needs Ollama)'}</button>${S.tools.ollama.models.some((x) => x.name === m.tag) ? '<span class="small muted">already installed</span>' : ''}</div>` : ''}
    </div>` : '';
  showModal(`<h2>Best local model</h2><h1>${r.top ? esc(r.top.name) : 'No model fits'}</h1>
    <div class="hw"><div class="stat"><div class="v">${Math.round(hw.ramGB)} GB</div><div class="l">memory</div></div><div class="stat"><div class="v">${hw.usableGB.toFixed(1)} GB</div><div class="l">usable for a model</div></div><div class="stat"><div class="v" style="font-size:14px;padding-top:4px">${esc(hw.chip)}</div><div class="l">chip</div></div></div>
    <p class="muted small">Your Mac has ${Math.round(hw.ramGB)} GB of memory. A local model can use about ${hw.usableGB.toFixed(1)} GB of it (65% minus 2 GB for macOS and your apps). It also needs about 1.5 GB extra while it works.</p>
    ${!ok ? `<div class="warnbox">Ollama isn't installed. Get it free at <button class="link-btn" id="olSite">ollama.com</button>, open it once, then come back here.</div>` : ''}
    ${card(r.top, 'top')}${r.runnersUp.map((m) => card(m, '')).join('')}${card(r.tooBig, 'big')}
    <div class="warnbox">Heads-up: ~9B local models are much weaker than Claude or Codex on big multi-file tasks. They're good for quick questions, small scripts and offline work. These are uncensored (abliterated) builds, so they refuse less and filter less.</div>
    <p class="small muted">${esc(r.note || '')}${r.refreshed ? ' Last catalog refresh: ' + new Date(r.refreshed).toLocaleString() + '.' : ''}</p>
    <div class="modal-foot"><button class="btn" id="refreshCat">Refresh catalog</button><button class="btn" data-close>Close</button></div>`);
  $('#modalBody').querySelectorAll('[data-pull]').forEach((b) => (b.onclick = () => {
    if (!ok) return showInstall('ollama');
    closeModal();
    openTab({ preset: 'ollama', pull: b.dataset.pull, cwd: null });
  }));
  const ol = $('#olSite'); if (ol) ol.onclick = () => api.openUrl('https://ollama.com/download');
  $('#refreshCat').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Checking ollama.com…';
    const res = await api.refreshCatalog();
    toast(res.missing.length ? `Couldn't find: ${res.missing.join(', ')}` : `All ${res.checked} models found, sizes updated`);
    openFinder();
  };
}

/* ---------- settings ---------- */
function openSettings() {
  const st = S.settings;
  const opts = S.tools.ollama.models.map((m) => m.name);
  if (st.defaultModel && !opts.includes(st.defaultModel)) opts.unshift(st.defaultModel);
  showModal(`<h2>Settings</h2><h1>Preferences</h1>
    <label class="field"><span>Projects folder</span><div class="row"><input id="sRoot" value="${esc(st.projectsRoot)}"><button class="btn" id="sBrowse">Browse</button></div></label>
    <label class="field"><span>Default local model</span><select id="sModel"><option value="">None</option>${opts.map((m) => `<option ${m === st.defaultModel ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
    <label class="field"><span>Accent color</span><input type="color" id="sAccent" value="${esc(st.accent)}"></label>
    <div class="field"><span>Extra environment variables per preset (one KEY=value per line)</span>
      <div class="env-grid">${Object.keys(S.presets).map((k) => `<label class="field" style="margin:4px 0"><span>${esc(S.presets[k].label)}</span><textarea data-env="${k}" spellcheck="false">${esc(st.env[k] || '')}</textarea></label>`).join('')}</div></div>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="sSave">Save</button></div>`);
  $('#sAccent').oninput = (e) => applyAccent(e.target.value);
  $('#sBrowse').onclick = async () => { const d = await api.chooseRoot(); if (d) $('#sRoot').value = d; };
  $('#sSave').onclick = () => {
    const env = {};
    $('#modalBody').querySelectorAll('[data-env]').forEach((t) => (env[t.dataset.env] = t.value));
    S.settings = { ...st, projectsRoot: $('#sRoot').value.trim() || '~/claude-projects', defaultModel: $('#sModel').value, accent: $('#sAccent').value, env };
    api.setState('settings', S.settings);
    applyAccent(S.settings.accent);
    closeModal(); renderModels(); renderLocal(); toast('Settings saved');
  };
  $('#modalBody').querySelector('[data-close]').addEventListener('click', () => applyAccent(S.settings.accent));
}
$('#settingsBtn').onclick = openSettings;

// Preview only; Save in Settings is what stores it.
function applyAccent(c) {
  document.documentElement.style.setProperty('--accent', c);
  for (const t of S.tabs) t.term.options.theme = termTheme(c);
}

/* ---------- home ---------- */
function renderHome() {
  const h = new Date().getHours();
  const quick = ['claude', 'codex', 'gemini', 'ollama', 'shell'].map((k) => `<button data-quick="${k}" class="${installed(k) ? '' : 'off'}"><span class="ico">${ICONS[k]}</span><span class="t">${esc(S.presets[k].label)}</span><span class="s">${installed(k) ? DESC[k] : 'Not installed'}</span></button>`).join('');
  $('#home').innerHTML = `
    <div class="headline-top">
      <div><div class="eyebrow">${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'} · ${S.projects.projects.length} projects</div><h1>Launch an AI in any project.</h1></div>
      <div class="headline-actions"><button class="chip" data-go="term">Open terminals</button><button class="chip primary" data-go="new">New terminal</button></div>
    </div>
    <div class="quick">${quick}</div>`;
  $('#emptyStage').innerHTML = `<span class="empty-ico">${ICONS.shell}</span><h1>Pick a project.</h1>
    <p class="muted">Choose one on the left, or start a terminal in your projects folder.</p>
    <div class="chips">${['claude', 'codex', 'gemini', 'ollama', 'shell'].map((k) => `<button class="chip ${installed(k) ? '' : 'off'}" data-quick="${k}">${esc(S.presets[k].label)}</button>`).join('')}</div>
    <div class="keys"><span><kbd>⌘T</kbd> new tab</span><span><kbd>⌘W</kbd> close</span><span><kbd>⌘1</kbd>–<kbd>⌘9</kbd> switch</span><span><kbd>⌘D</kbd> split</span></div>`;
}
$('#emptyStage').addEventListener('click', (e) => { const q = e.target.closest('[data-quick]'); if (q) openTab({ preset: q.dataset.quick, cwd: S.projects.exists ? S.projects.dir : null }); });
$('#home').addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) return g.dataset.go === 'term' ? setView('term') : openLauncher(null);
  const q = e.target.closest('[data-quick]');
  if (q) return openTab({ preset: q.dataset.quick, cwd: S.projects.exists ? S.projects.dir : null });
});

/* ---------- boot ---------- */
(async function init() {
  const st = await api.getState();
  Object.assign(S, { settings: st.settings, presets: st.presets, lastAi: st.lastAi, favorites: st.favorites });
  document.documentElement.style.setProperty('--accent', S.settings.accent);
  renderSystemShell(); renderTabs(); renderHome(); renderActivity();
  S.projects = await api.listProjects();
  renderProjects(); renderHome();
  await refreshTools();
  renderHome();
  for (const t of st.tabs || []) await openTab({ ...t, quiet: true });
  if (S.tabs[0]) S.active = S.tabs[0].uid; // restored tabs wait behind the Terminals view
  setView('dash'); renderTabs();
  tickSystem(); setInterval(tickSystem, 3000);
  await refreshLive(); setInterval(() => !document.hidden && refreshLive(), 15000); // before autoCapture, so a live value skips the hidden terminal
  autoCapture(); setInterval(autoCapture, 60e3);
  refreshLogs(); setInterval(() => !document.hidden && refreshLogs(), 120000);
  setInterval(() => !document.hidden && refreshTools(), 30000);
})();
