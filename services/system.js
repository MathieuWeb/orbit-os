// Live RAM / CPU and tool detection.
const os = require('os');
const { execFile } = require('child_process');
const http = require('http');

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 8000 }, (e, out) => res(e ? null : out)));

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

// `command -v` inside a login shell, so PATH matches the user's Terminal.
async function which(bin) {
  const out = await run(process.env.SHELL || '/bin/zsh', ['-l', '-c', `command -v ${bin}`]);
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

module.exports = { memory, cpu, which, ollama };
