const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const createStore = require('./services/store');
const projects = require('./services/projects');
const usage = require('./services/usage');
const finder = require('./services/modelFinder');
const system = require('./services/system');

// Renamed from "AI Terminal": keep the existing settings, tabs and favorites folder.
app.setPath('userData', path.join(app.getPath('appData'), 'AI Terminal'));

const SHELL = process.env.SHELL || '/bin/zsh';
const MODEL_RE = /^[\w.\-/:]+$/; // Ollama tags: letters, digits, . - _ / :

// Add a preset here: key -> label, binary to check, and the command to run (null = plain shell).
const PRESETS = {
  claude: { label: 'Claude Code', bin: 'claude', cmd: () => `claude --settings ${shq(claudeStatusSettings())}` },
  codex: { label: 'Codex', bin: 'codex', cmd: () => 'codex' },
  // Key stays 'gemini' (saved tabs/settings); Google replaced Gemini CLI with Antigravity CLI (agy) in June 2026.
  gemini: { label: 'Antigravity', bin: 'gemini', cmd: () => 'agy' },
  ollama: { label: 'Local model', bin: 'ollama', cmd: (o) => `ollama run ${o.model}` },
  shell: { label: 'Plain terminal', bin: null, cmd: () => null },
};

let win, store, stopWatch;
const ptys = new Map();
let nextId = 1;

const send = (ch, ...a) => win && !win.isDestroyed() && win.webContents.send(ch, ...a);

function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// Drop session vars inherited when the app itself was started from a Claude Code terminal;
// the login shell re-adds anything the user sets in their own profile.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/.test(k)));

function baseEnv(preset) {
  return {
    ...inherited,
    LANG: process.env.LANG || 'en_US.UTF-8',
    ...parseEnv(store.get('settings').env[preset]),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'AI-Terminal',
  };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const statusFile = () => path.join(app.getPath('userData'), 'claude-status.json');

// Live Claude limits: app-launched sessions get a status line script that saves the status JSON
// (it carries `rate_limits`), then runs the user's own status line so theirs still shows.
function claudeStatusSettings() {
  const dir = app.getPath('userData');
  let own = '';
  try { own = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.claude', 'settings.json'), 'utf8')).statusLine?.command || ''; } catch {}
  const f = statusFile(), script = path.join(dir, 'claude-status.sh'), settings = path.join(dir, 'claude-settings.json');
  fs.writeFileSync(script, `#!/bin/sh\nf=${shq(f)}\ncat > "$f.tmp" && mv "$f.tmp" "$f"\n${own ? `sh -c ${shq(own)} < "$f"\n` : ''}`);
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: `sh ${shq(script)}` } }));
  return settings;
}

function catalogFile() { return path.join(app.getPath('userData'), 'models.json'); }
function loadCatalog() {
  for (const f of [catalogFile(), path.join(__dirname, 'models.json')]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return { models: [] };
}

// ---------- terminals ----------
ipcMain.handle('pty:spawn', (_e, { preset, cwd, cols, rows, model, pull }) => {
  const p = PRESETS[preset];
  if (!p) throw new Error('Unknown preset');
  const dir = cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : require('os').homedir();
  let cmd;
  if (pull) {
    if (!MODEL_RE.test(pull)) throw new Error('Bad model tag');
    // Invisible OSC marker tells us the pull succeeded so we can set it as default.
    cmd = `ollama pull ${pull} && printf '\\033]7777;pull-ok\\007'`;
  } else {
    const m = model || store.get('settings').defaultModel;
    if (preset === 'ollama' && !MODEL_RE.test(m || '')) throw new Error('No local model chosen yet');
    cmd = p.cmd({ model: m });
  }
  // After the AI exits you land in a normal login shell, like Terminal.app.
  const args = cmd ? ['-l', '-i', '-c', `${cmd}; exec ${SHELL} -l`] : ['-l'];
  const proc = pty.spawn(SHELL, args, { name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: dir, env: baseEnv(preset) });
  const id = nextId++;
  ptys.set(id, proc);
  proc.onData((d) => {
    if (pull && d.includes('\x1b]7777;pull-ok\x07')) {
      store.set('settings', { ...store.get('settings'), defaultModel: pull });
      send('model:default', pull);
    }
    send('pty:data', id, d);
  });
  proc.onExit(({ exitCode }) => { ptys.delete(id); send('pty:exit', id, exitCode); });
  return { id, cwd: dir };
});
ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => { try { ptys.get(id)?.resize(Math.max(2, cols), Math.max(2, rows)); } catch {} });
ipcMain.on('pty:kill', (_e, id) => { try { ptys.get(id)?.kill(); } catch {} ptys.delete(id); });

// ---------- state ----------
ipcMain.handle('state:get', () => ({
  settings: store.get('settings'), tabs: store.get('tabs'), lastAi: store.get('lastAi'), favorites: store.get('favorites'),
  presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, bin: v.bin }])),
}));
ipcMain.handle('state:set', (_e, key, value) => {
  if (!['settings', 'tabs', 'lastAi', 'favorites'].includes(key)) return;
  const before = store.get('settings').projectsRoot;
  store.set(key, value);
  if (key === 'settings' && value.projectsRoot !== before) watchProjects();
});

// ---------- projects ----------
function watchProjects() {
  stopWatch && stopWatch();
  const root = store.get('settings').projectsRoot;
  stopWatch = projects.watch(root, (l) => send('projects:changed', l));
  send('projects:changed', projects.list(root));
}
ipcMain.handle('projects:list', () => projects.list(store.get('settings').projectsRoot));
ipcMain.handle('projects:create', () => {
  fs.mkdirSync(projects.expand(store.get('settings').projectsRoot), { recursive: true });
  watchProjects();
});
ipcMain.handle('projects:chooseRoot', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- tools, system, usage ----------
ipcMain.handle('tools:status', async () => {
  const [claude, codex, gemini, ollama] = await Promise.all(['claude', 'codex', 'agy', 'ollama'].map(system.which));
  return { installed: { claude: !!claude, codex: !!codex, gemini: !!gemini, ollama: !!ollama }, ollama: await system.ollama() };
});
ipcMain.handle('system:apps', () => system.apps());
ipcMain.handle('system:free', async (_e, { apps = [], models = [] }) => {
  // Only quit apps that are in our own current list; the renderer's names are not trusted as-is.
  const known = new Set((await system.apps()).map((a) => a.name));
  const quit = await Promise.all(apps.filter((n) => known.has(n)).map(system.quitApp));
  const loaded = new Set(((await system.ollama()).loaded || []).map((m) => m.name));
  await Promise.all(models.filter((m) => loaded.has(m)).map(system.unloadModel));
  return { quit: quit.filter(Boolean).length, asked: apps.length };
});
ipcMain.handle('system:stats', async () => ({ ...(await system.memory()), cpu: system.cpu() }));
ipcMain.handle('usage:logs', async () => {
  const [claude, codex] = await Promise.all([usage.claudeStats(), usage.codexStats()]);
  return { claude, codex };
});
// The renderer polls every 15 s; vendor servers are asked at most every 45 s.
const apiCache = { at: 0, claude: null, codex: null };
ipcMain.handle('usage:live', async () => {
  if (Date.now() - apiCache.at > 45e3) {
    apiCache.at = Date.now();
    [apiCache.claude, apiCache.codex] = await Promise.all([usage.claudeApi(), usage.codexApi()]);
  }
  let claude = apiCache.claude;
  if (!claude) try {
    const f = statusFile(), items = usage.claudeLive(JSON.parse(fs.readFileSync(f, 'utf8')));
    if (items.length) claude = { items, at: fs.statSync(f).mtimeMs };
  } catch {}
  const codex = apiCache.codex || usage.codexLive();
  return { claude: claude && { ok: true, live: true, ...claude }, codex: codex && { ok: true, live: true, ...codex } };
});
const capturing = {};
ipcMain.handle('usage:capture', async (_e, tool) => {
  const cfg = { claude: { cmd: 'claude', slash: '/usage' }, codex: { cmd: 'codex', slash: '/status' }, gemini: { cmd: 'agy', slash: '/usage' } }[tool];
  if (!cfg) return null;
  if (!(await system.which(cfg.cmd))) return { ok: false, error: 'not installed', at: Date.now() };
  // One capture per tool at a time; a second click reuses the running one.
  capturing[tool] ||= usage.captureCli({ ...cfg, cwd: path.join(app.getPath('userData'), 'usage-probe'), env: baseEnv(tool) })
    .catch((e) => ({ ok: false, error: e.message, text: '' }))
    .finally(() => { capturing[tool] = null; });
  const r = await capturing[tool];
  if (r.ok && /How would you like to authenticate|Sign in with Google/i.test(r.text || '')) return { ...r, ok: false, error: 'Not signed in yet. Open it once in a tab and log in.', items: [], at: Date.now() };
  return { ...r, items: r.ok ? usage.parseUsage(r.text || '') : [], at: Date.now() };
});

// ---------- model finder ----------
ipcMain.handle('finder:run', () => {
  const hw = finder.detectHardware();
  const catalog = loadCatalog();
  return { hw, ...finder.pick(catalog.models, hw.usableGB), note: catalog.note, refreshed: catalog.refreshed || null };
});
ipcMain.handle('finder:refresh', async () => {
  const catalog = loadCatalog();
  const models = await finder.refreshCatalog(catalog.models);
  fs.writeFileSync(catalogFile(), JSON.stringify({ ...catalog, models, refreshed: new Date().toISOString() }, null, 2));
  return { checked: models.length, missing: models.filter((m) => !m.verified).map((m) => m.tag) };
});
ipcMain.handle('open:url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

// ---------- window ----------
function createWindow() {
  const b = store.get('window');
  win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y, minWidth: 960, minHeight: 600,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#05070d', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', () => store.set('window', win.getBounds()));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// No Cmd+W "close window" here: the renderer uses Cmd+W to close a tab.
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'Orbit OS', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
  { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
  { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
]));

app.whenReady().then(() => {
  store = createStore(app.getPath('userData'));
  createWindow();
  win.webContents.once('did-finish-load', watchProjects);
  // Dev only: AIT_SHOT=/path.png [AIT_EVAL="js"] npm start -> runs the JS, saves a screenshot, quits.
  if (process.env.AIT_SHOT) win.webContents.on('console-message', (e) => console.log('[renderer]', e.message || e));
  if (process.env.AIT_SHOT) win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 3000));
    if (process.env.AIT_EVAL) { await win.webContents.executeJavaScript(process.env.AIT_EVAL).catch((e) => console.error(e)); await new Promise((r) => setTimeout(r, Number(process.env.AIT_WAIT || 2500))); }
    fs.writeFileSync(process.env.AIT_SHOT, (await win.webContents.capturePage()).toPNG());
    app.quit();
  });
});
app.on('before-quit', () => { for (const p of ptys.values()) { try { p.kill(); } catch {} } store && store.flush(); });
app.on('window-all-closed', () => app.quit());
