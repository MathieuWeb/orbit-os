// Usage: (a) captures `/usage` (Claude) and `/status` (Codex) from the real CLIs in a hidden
// terminal, (b) sums token counts from local session logs. Only counts, timestamps and the
// project folder name are kept; message content is never stored or returned.
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- (a) hidden-terminal capture ----------
// Renders the CLI into a headless xterm so TUI redraws give clean screen text, not ANSI soup.
async function captureCli({ cmd, slash, cwd, env, shell = process.env.SHELL || '/bin/zsh' }) {
  fs.mkdirSync(cwd, { recursive: true });
  const cols = 110, rows = 50;
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  const p = pty.spawn(shell, ['-l', '-i', '-c', cmd], { cols, rows, cwd, env: { ...process.env, ...env, TERM: 'xterm-256color' } });
  let last = Date.now(), exited = false;
  p.onData((d) => { last = Date.now(); term.write(d); });
  p.onExit(() => { exited = true; });
  const screen = () => {
    const b = term.buffer.active, out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  const idle = async (quietMs, maxMs) => {
    const end = Date.now() + maxMs;
    while (!exited && Date.now() < end && Date.now() - last < quietMs) await sleep(150);
  };
  try {
    await idle(2500, 20000);
    // The probe folder is an empty app-owned folder, so accepting "trust this folder" is harmless.
    // The default choice is "No, exit", so move down to "Yes" first.
    if (/Yes, I trust this folder/i.test(screen())) {
      p.write('\x1b[B'); await sleep(300); p.write('\r');
      last = Date.now(); await idle(2500, 15000);
    }
    if (exited) return { ok: false, text: screen(), error: 'The program closed before the command could run.' };
    if (/sign in with|log ?in to|please log ?in|not logged in/i.test(screen())) {
      return { ok: false, text: screen(), error: 'Not signed in yet. Open it once in a tab and log in, then refresh.' };
    }
    term.clear();
    for (const ch of slash) { p.write(ch); await sleep(25); }
    await sleep(400);
    p.write('\r');
    await sleep(1500);
    await idle(2000, 15000);
    return { ok: true, text: screen() };
  } finally {
    try { p.write('\x1b'); p.kill(); } catch {}
    term.dispose();
  }
}

// Pulls "Label ... 42% used ... Resets X" rows out of the captured text.
// "15:39 on 21 Nov)" -> drop a ")" that closes nothing; keep "(Europe/Paris)".
const cleanReset = (s) => { s = s.trim(); return (s.match(/\)/g) || []).length > (s.match(/\(/g) || []).length ? s.replace(/\)\s*$/, "").trim() : s; };
function parseUsage(text) {
  const lines = text.split('\n').map((l) => l.replace(/[█▉▊▋▌▍▎▏░▒▓■□━─│╭╮╰╯\[\]]/g, " ").replace(/\s+/g, ' ').trim());
  const items = [];
  let leftCol = false; // Gemini /stats: a "Usage left" column, rows like "gemini-2.5-pro  12  93.4% (Resets in 20h)"
  lines.forEach((l, i) => {
    if (/usage (left|remaining)/i.test(l)) leftCol = true;
    const g = leftCol && l.match(/^(gemini[\w.\-]*)\b.*?(\d{1,3}(?:\.\d+)?)\s*%/i);
    if (g) {
      const r = l.match(/resets?\s+([^·|]+)/i);
      return items.push({ label: g[1], percentUsed: Math.round((100 - Number(g[2])) * 10) / 10, resets: r ? cleanReset(r[1]).slice(0, 50) : null });
    }
    const m = l.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(used|left)/i);
    if (!m) return;
    let label = l.slice(0, m.index).trim();
    if (!/[a-z]/i.test(label)) label = (lines.slice(Math.max(0, i - 2), i).reverse().find((x) => /[a-z]/i.test(x)) || '').trim();
    const reset = (l + ' ' + (lines[i + 1] || '')).match(/resets?\s+([^·|]+)/i);
    let pct = Number(m[1]);
    if (/left/i.test(m[2] || '')) pct = 100 - pct;
    if (pct > 100 || !label) return;
    items.push({ label: label.replace(/[:·]+$/, '').slice(0, 60), percentUsed: pct, resets: reset ? cleanReset(reset[1]).slice(0, 50) : null });
  });
  return items;
}

// ---------- (b) local session logs ----------
async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) fn(line);
}

function walk(dir, ext, since, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, since, out);
    else if (e.name.endsWith(ext)) { try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch {} }
  }
  return out;
}

function emptyStats() {
  return { available: false, today: { tokens: 0, sessions: 0 }, week: { tokens: 0, sessions: 0 }, days: {}, projects: {} };
}

function startOfWeek() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 6); return d; }
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function add(stats, sessionsSeen, ts, tokens, sessionId, project) {
  const d = new Date(ts);
  if (isNaN(d) || d < startOfWeek()) return;
  const day = dayKey(d), today = dayKey(new Date());
  stats.available = true;
  stats.days[day] = (stats.days[day] || 0) + tokens;
  stats.week.tokens += tokens;
  stats.projects[project] = (stats.projects[project] || 0) + tokens;
  if (day === today) stats.today.tokens += tokens;
  if (!sessionsSeen.has(sessionId)) { sessionsSeen.add(sessionId); stats.week.sessions++; }
  if (day === today && !sessionsSeen.has('t:' + sessionId)) { sessionsSeen.add('t:' + sessionId); stats.today.sessions++; }
}

const claudeTokens = (u) => (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
const codexTokens = (u) => (u.input_tokens || 0) - (u.cached_input_tokens || 0) + (u.output_tokens || 0);

// Tokens one open tab has used: log lines for that folder written since the tab opened.
// shortcut: two tabs of the same AI in the same folder share one total; split by session id if that matters.
async function tabTokens(tool, cwd, since, root) {
  const claude = tool === 'claude';
  root ||= path.join(os.homedir(), claude ? '.claude/projects' : '.codex/sessions');
  let total = 0;
  const ids = new Set();
  for (const f of walk(root, '.jsonl', since)) {
    let here = claude;
    await eachLine(f, (line) => {
      if (claude ? !line.includes('"usage"') : !line.includes('session_meta') && !line.includes('token_count')) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      if (Date.parse(o.timestamp) < since && o.type !== 'session_meta') return;
      if (claude) {
        const u = o.type === 'assistant' && o.cwd === cwd && o.message && o.message.usage, id = u && (o.message.id || o.uuid);
        if (u && !ids.has(id)) { ids.add(id); total += claudeTokens(u); }
      } else {
        const p = o.payload || {};
        if (o.type === 'session_meta') here = p.cwd === cwd;
        else if (here && p.type === 'token_count' && p.info && p.info.last_token_usage) total += codexTokens(p.info.last_token_usage);
      }
    });
  }
  return total;
}

// Tokens = input + output + cache writes (cache reads are excluded: they re-count the same context).
async function claudeStats(root = path.join(os.homedir(), '.claude', 'projects')) {
  const stats = emptyStats(), seen = new Set(), ids = new Set();
  for (const f of walk(root, '.jsonl', startOfWeek().getTime())) {
    await eachLine(f, (line) => {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      const u = o.message && o.message.usage;
      if (o.type !== 'assistant' || !u) return;
      const id = o.message.id || o.uuid;
      if (ids.has(id)) return; // one API message is logged once per content block
      ids.add(id);
      const tokens = claudeTokens(u);
      add(stats, seen, o.timestamp, tokens, o.sessionId || f, path.basename(o.cwd || path.dirname(f)));
    });
  }
  return stats;
}

// Codex rollout files: session_meta gives cwd, token_count events give per-turn usage.
async function codexStats(root = path.join(os.homedir(), '.codex', 'sessions')) {
  const stats = emptyStats(), seen = new Set();
  for (const f of walk(root, '.jsonl', startOfWeek().getTime())) {
    let project = 'unknown';
    await eachLine(f, (line) => {
      if (!line.includes('session_meta') && !line.includes('token_count')) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      const p = o.payload || {};
      if (o.type === 'session_meta' && p.cwd) project = path.basename(p.cwd);
      const u = p.type === 'token_count' && p.info && p.info.last_token_usage;
      if (!u) return;
      const tokens = codexTokens(u);
      add(stats, seen, o.timestamp, tokens, f, project);
    });
  }
  return stats;
}

// ---------- (c) live plan limits, no credentials ----------
// resets_at may come as unix seconds, ms or an ISO string depending on the CLI version.
function resetText(v, inSeconds) {
  let d = inSeconds != null ? new Date(Date.now() + inSeconds * 1000) : typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : v ? new Date(v) : null;
  if (!d || isNaN(d)) return null;
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
const item = (label, pct, reset) => ({ label, percentUsed: Math.round(Math.min(100, Math.max(0, Number(pct)))), resets: reset });

// Claude Code passes `rate_limits` to the status line command; our script saves that JSON.
function claudeLive(json) {
  const r = json && json.rate_limits;
  if (!r) return [];
  return [['five_hour', 'Current session (5 h)'], ['seven_day', 'Current week']]
    .filter(([k]) => r[k] && r[k].used_percentage != null)
    .map(([k, label]) => item(label, r[k].used_percentage, resetText(r[k].resets_at)));
}

// Last `rate_limits` in the newest Codex rollout file (written on every turn).
function codexLive(root = path.join(os.homedir(), '.codex', 'sessions')) {
  const files = walk(root, '.jsonl', Date.now() - 7 * 864e5).map((f) => [f, fs.statSync(f).mtimeMs]).sort((a, b) => b[1] - a[1]);
  for (const [f, mtime] of files.slice(0, 5)) {
    let tail;
    try {
      const fd = fs.openSync(f, 'r'), size = fs.fstatSync(fd).size, len = Math.min(size, 256 * 1024), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
      tail = buf.toString('utf8').split('\n').reverse();
    } catch { continue; }
    for (const line of tail) {
      if (!line.includes('rate_limits')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const r = o.payload && o.payload.rate_limits;
      if (!r) continue;
      const win = (w, fallback) => w && w.used_percent != null && item(
        w.window_minutes ? (w.window_minutes <= 600 ? `${Math.round(w.window_minutes / 60)} h limit` : 'Weekly limit') : fallback,
        w.used_percent, resetText(w.resets_at, w.resets_at == null ? w.resets_in_seconds : null));
      const items = [win(r.primary, '5 h limit'), win(r.secondary, 'Weekly limit')].filter(Boolean);
      if (items.length) return { items, at: Date.parse(o.timestamp) || mtime };
    }
  }
  return null;
}

// ---------- (c) direct plan usage, the way menu-bar usage apps do it ----------
// Reuses the login each CLI already saved on this Mac; the token is sent only to that vendor's own server.
// shortcut: undocumented endpoints that may change; the hidden-terminal capture stays as the fallback.
const { execFile } = require('child_process');
const keychain = (service) => new Promise((res) => execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 }, (e, out) => res(e ? null : out.trim())));
const getJson = async (url, headers) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  return r.ok ? r.json() : null;
};

function claudeApiItems(j) {
  return [['five_hour', 'Current session (5 h)'], ['seven_day', 'Current week (all models)']]
    .filter(([k]) => j && j[k] && j[k].utilization != null)
    .map(([k, label]) => item(label, j[k].utilization, resetText(j[k].resets_at)));
}
async function claudeApi() {
  try {
    const raw = await keychain('Claude Code-credentials');
    const token = raw && JSON.parse(raw).claudeAiOauth?.accessToken;
    if (!token) return null;
    const items = claudeApiItems(await getJson('https://api.anthropic.com/api/oauth/usage', { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' }));
    return items.length ? { items, at: Date.now() } : null;
  } catch { return null; }
}

function codexApiItems(j) {
  const rl = j && (j.rate_limit || j.rate_limits);
  if (!rl) return [];
  const win = (w, fallback) => w && w.used_percent != null && item(
    w.limit_window_seconds ? (w.limit_window_seconds <= 36000 ? `${Math.round(w.limit_window_seconds / 3600)} h limit` : 'Weekly limit') : fallback,
    w.used_percent, resetText(w.reset_at, w.reset_at == null ? w.reset_after_seconds : null));
  return [win(rl.primary_window, '5 h limit'), win(rl.secondary_window, 'Weekly limit')].filter(Boolean);
}
async function codexApi() {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8')).tokens || {};
    if (!t.access_token) return null;
    const items = codexApiItems(await getJson('https://chatgpt.com/backend-api/wham/usage', { Authorization: 'Bearer ' + t.access_token, ...(t.account_id ? { 'ChatGPT-Account-Id': t.account_id } : {}) }));
    return items.length ? { items, at: Date.now() } : null;
  } catch { return null; }
}

module.exports = { tabTokens, captureCli, parseUsage, claudeStats, codexStats, claudeLive, codexLive, claudeApi, codexApi, claudeApiItems, codexApiItems };
