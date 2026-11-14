// Live RAM / CPU and tool detection.
const os = require('os');
const { execFile } = require('child_process');
const http = require('http');

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 8000, maxBuffer: 8 << 20 }, (e, out) => res(e ? null : out)));

// Matches Activity Monitor's "Memory Used": app memory + wired + compressed.
async function memory() {
  const out = await run('/usr/bin/vm_stat', []);
  const total = os.totalmem();
  if (!out) return { total, used: total - os.freemem() };
  const page = Number((out.match(/page size of (\d+)/) || [])[1] || 16384);
  const v = (k) => Number((out.match(new RegExp(k + ':\\s+(\\d+)')) || [])[1] || 0);
  const used = (v('Anonymous pages') - v('Pages purgeable') + v('Pages wired down') + v('Pages occupied by compressor')) * page;
  return { total, used: Math.min(total, Math.max(0, used)) };
}

let prev = os.cpus();
function cpu() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = prev[i].times, t = c.times;
    const d = (k) => t[k] - p[k];
    idle += d('idle');
    total += d('user') + d('nice') + d('sys') + d('idle') + d('irq');
  });
  prev = now;
  return total ? Math.round((1 - idle / total) * 100) : 0;
}

// Interactive login shell: PATH set in ~/.zshrc (nvm, ~/.local/bin) is invisible to a plain -l shell when launched from Finder.
async function which(bin) {
  const out = await run(process.env.SHELL || '/bin/zsh', ['-l', '-i', '-c', `command -v ${bin}`]);
  return out ? out.trim().split('\n').pop() : null;
}

function ollamaApi(p) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: 11434, path: p, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); });
  });
}

async function ollama() {
  const [tags, ps] = await Promise.all([ollamaApi('/api/tags'), ollamaApi('/api/ps')]);
  if (!tags) return { running: false, models: [], loaded: [] };
  return {
    running: true,
    models: (tags.models || []).map((m) => ({ name: m.name, sizeGB: +(m.size / 1e9).toFixed(1) })),
    loaded: ((ps && ps.models) || []).map((m) => ({ name: m.name, ramGB: +(m.size / 1e9).toFixed(1) })),
  };
}

// Apps the user opened (bundles in an Applications folder), with their helpers' memory summed.
// RSS counts shared pages in each process, so totals are an estimate (shown with ≈).
const APP_RE = new RegExp(`^(?:/System)?(?:/Applications|${os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Applications)/(?:[^/]+/)*?([^/]+)\\.app/`);
const own = (process.execPath.match(/([^/]+)\.app\//) || [])[1];
async function apps() {
  const out = await run('/bin/ps', ['-axo', 'rss=,comm=']);
  const by = {};
  for (const line of (out || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    const a = m && m[2].match(APP_RE);
    if (!a || a[1] === own || a[1] === 'Finder') continue;
    by[a[1]] = (by[a[1]] || 0) + Number(m[1]) * 1024;
  }
  return Object.entries(by).map(([name, bytes]) => ({ name, mb: Math.round(bytes / 1048576) }))
    .filter((a) => a.mb >= 50).sort((a, b) => b.mb - a.mb);
}

// Polite quit (same as Cmd+Q): apps with unsaved work ask before closing. Never force-killed.
const quitApp = (name) => run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application (item 1 of argv) to quit', '-e', 'end run', name]).then((o) => o !== null);

// keep_alive 0 makes Ollama drop the model from memory now.
function unloadModel(model) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST', timeout: 5000, headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false)).on('timeout', () => { req.destroy(); resolve(false); });
    req.end(JSON.stringify({ model, keep_alive: 0 }));
  });
}

module.exports = { memory, cpu, which, ollama, apps, quitApp, unloadModel, APP_RE };
