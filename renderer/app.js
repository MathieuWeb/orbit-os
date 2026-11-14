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
  ollama: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/><circle cx="12" cy="12" r="2"/></svg>',
  shell: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-6.5 8 6.5M6 9.5V19h12V9.5"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2.5-6 5 12 2.5-6h4"/></svg>',
};
const DESC = { claude: 'Anthropic coding agent', codex: 'OpenAI coding agent', ollama: 'Free model on your Mac', shell: 'Your normal zsh' };
const INSTALL = {
  claude: { title: 'Claude Code is not installed', steps: ['curl -fsSL https://claude.ai/install.sh | bash'], after: 'Then open a Claude Code tab and follow the login steps.', url: 'https://docs.claude.com/en/docs/claude-code/setup' },
  codex: { title: 'Codex is not installed', steps: ['npm install -g @openai/codex'], after: 'Then open a Codex tab and sign in with your ChatGPT account.', url: 'https://github.com/openai/codex' },
  ollama: { title: 'Ollama is not installed', steps: [], after: 'Download the Ollama app, drag it to Applications and open it once. It runs quietly in the menu bar.', url: 'https://ollama.com/download' },
};

const S = {
  settings: null, presets: {}, lastAi: {}, favorites: [],
  tabs: [], active: 'home', pair: null,
  projects: { exists: true, projects: [], dir: '' },
  tools: { installed: {}, ollama: { running: false, models: [], loaded: [] } },
  logs: null, usage: { claude: null, codex: null }, loading: {}, activityTool: 'claude', search: '',
};
let uid = 0;
const byPty = new Map();

/* ---------- terminal theme ---------- */
function termTheme(a = S.settings.accent) {
  return {
    background: '#070a12', foreground: '#d6deeb', cursor: a, cursorAccent: '#05070d',
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

function activate(id) { S.active = id; layout(); renderTabs(); }

function layout() {
  const show = S.pair && S.pair.includes(S.active) ? S.pair : [S.active];
  $('#home').style.display = S.active === 'home' ? '' : 'none';
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
    if (cur && $('#modal').hidden) cur.term.focus();
  });
}

function tabLabel(t) { return t.pull ? 'Install ' + t.pull.split(':').pop() : (t.project || base(t.cwd)); }

function renderTabs() {
  const homeBtn = `<button class="tab ${S.active === 'home' ? 'active' : ''}" data-id="home" role="tab" title="Home">${ICONS.home}</button>`;
  $('#tabs').innerHTML = homeBtn + S.tabs.map((t, i) => `
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
$('#newBtn').onclick = () => openLauncher(currentProject());

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
  const order = ['claude', 'codex', 'ollama', 'shell'];
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
  $('#modelCards').innerHTML = ['claude', 'codex', 'ollama'].map((k) => {
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
$('#modelCards').addEventListener('click', (e) => { const b = e.target.closest('[data-install]'); if (b) showInstall(b.dataset.install); });
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
  renderModels(); renderLocal(); renderUsage('claude'); renderUsage('codex');
  if (announce) toast('Tools checked');
}

/* ---------- usage cards ---------- */
function renderUsage(tool) {
  const el = $(tool === 'claude' ? '#usageClaude' : '#usageCodex');
  const name = tool === 'claude' ? 'Claude Code' : 'Codex';
  const cmd = tool === 'claude' ? '/usage' : '/status';
  const u = S.usage[tool], loading = S.loading[tool];
  let body;
  if (!S.tools.installed[tool]) body = `<p class="na">Not installed. <button class="link-btn" data-install="${tool}">How to install</button></p>`;
  else if (loading) body = `<p class="muted small">Opening ${name} in the background and reading <code>${cmd}</code>… (about 10 seconds)</p>`;
  else if (!u) body = `<p class="muted small">Press Refresh to read your plan usage from <code>${cmd}</code>.</p>`;
  else {
    const meters = (u.items || []).map((m) => `<div class="meter"><div class="meter-top"><span>${esc(m.label)}</span><b>${m.percentUsed}%</b></div>
      <div class="bar ${m.percentUsed >= 80 ? 'hot' : ''}"><i data-w="${m.percentUsed}"></i></div>${m.resets ? `<div class="reset">Resets ${esc(m.resets)}</div>` : ''}</div>`).join('');
    body = (u.error ? `<p class="na">${esc(u.error === 'not installed' ? 'Not available' : u.error)}</p>` : '')
      + (meters || (u.ok ? '<p class="na">Plan limits: not available (could not read them from the output).</p>' : ''))
      + `<div class="reset">Last refreshed ${timeStr(u.at)}</div>`
      + (u.text ? `<details><summary>Raw output</summary><pre class="raw">${esc(u.text)}</pre></details>` : '');
  }
  el.innerHTML = `<div class="card-head">${ICONS[tool]}<h2>${name} usage</h2>${S.tools.installed[tool] ? `<button class="btn" data-refresh="${tool}" ${loading ? 'disabled' : ''}>${loading ? 'Reading…' : 'Refresh'}</button>` : ''}</div>${body}`;
  requestAnimationFrame(() => el.querySelectorAll('.bar i[data-w]').forEach((i) => (i.style.width = i.dataset.w + '%')));
}
$('#panel').addEventListener('click', async (e) => {
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
async function refreshLogs() { S.logs = await api.usageLogs(); renderActivity(); }

/* ---------- local model + system ---------- */
function renderLocal() {
  const o = S.tools.ollama, d = S.settings.defaultModel;
  const status = !S.tools.installed.ollama ? 'Not installed' : o.running ? 'Running' : 'App not open';
  const loaded = o.loaded.length ? o.loaded.map((m) => `<div class="kv"><span>${esc(m.name)}</span><span>${m.ramGB} GB RAM</span></div>`).join('') : '<div class="kv"><span>In memory</span><span class="na">none</span></div>';
  $('#localCard').innerHTML = `<div class="card-head">${ICONS.ollama}<h2>Local model</h2></div>
    <div class="kv"><span>Ollama</span><span>${status}</span></div>
    <div class="kv"><span>Default model</span><span title="${esc(d)}">${d ? esc(d) : '<span class="na">not set</span>'}</span></div>
    ${loaded}
    <button class="btn primary" id="findModel" style="margin-top:10px;width:100%;justify-content:center">Find best local model</button>
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
    <div class="kv small" style="margin-top:8px"><span>Memory used</span><span id="ramText">–</span></div>`;
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
  $('#topStatus').innerHTML = `<span>RAM <b>${usedGB.toFixed(1)}/${Math.round(totGB)} GB</b></span><span>CPU <b>${s.cpu}%</b></span><span>Tabs <b>${S.tabs.length}</b></span>`;
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
  const recents = [...new Set([...S.favorites, ...Object.keys(S.lastAi)])]
    .map((n) => S.projects.projects.find((p) => p.name === n)).filter(Boolean).slice(0, 8);
  const h = new Date().getHours();
  $('#home').innerHTML = `
    <h1>${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}. <em>Command center online.</em></h1>
    <p class="lead">Pick a project on the left, or start something below.</p>
    <h3>Quick launch</h3>
    <div class="quick">${['claude', 'codex', 'ollama', 'shell'].map((k) => `<button data-quick="${k}"><span class="ico">${ICONS[k]}</span><span class="t">${esc(S.presets[k].label)}</span><span class="s">${installed(k) ? DESC[k] : 'Not installed'}</span></button>`).join('')}</div>
    ${recents.length ? `<h3>Pinned and recent</h3><div class="recent">${recents.map((p) => { const ai = S.lastAi[p.name] || 'claude'; return `<button data-recent="${esc(p.name)}" title="Open with ${esc(S.presets[ai].label)}">${ICONS[ai]}<span><div>${esc(p.name)}</div><div class="s">${esc(S.presets[ai].label)}${S.favorites.includes(p.name) ? ' · ★' : ''}</div></span></button>`; }).join('')}</div>` : ''}
    <h3>Shortcuts</h3>
    <div class="keys"><span><kbd>⌘T</kbd> new tab</span><span><kbd>⌘W</kbd> close tab</span><span><kbd>⌘1</kbd>–<kbd>⌘9</kbd> switch tab</span><span><kbd>⌘D</kbd> split view</span><span><kbd>⌘C</kbd> / <kbd>⌘V</kbd> copy / paste</span></div>`;
}
$('#home').addEventListener('click', (e) => {
  const q = e.target.closest('[data-quick]');
  if (q) return openTab({ preset: q.dataset.quick, cwd: S.projects.exists ? S.projects.dir : null });
  const r = e.target.closest('[data-recent]');
  if (r) { const p = S.projects.projects.find((x) => x.name === r.dataset.recent); openTab({ preset: S.lastAi[p.name] || 'claude', cwd: p.path, project: p.name }); }
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
  if (st.tabs?.length) activate(S.tabs[0]?.uid ?? 'home');
  tickSystem(); setInterval(tickSystem, 3000);
  refreshLogs(); setInterval(() => !document.hidden && refreshLogs(), 120000);
  setInterval(() => !document.hidden && refreshTools(), 30000);
})();
