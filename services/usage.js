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
function parseUsage(text) {
  const lines = text.split('\n').map((l) => l.replace(/[█▉▊▋▌▍▎▏░▒▓■□━─│╭╮╰╯]/g, ' ').replace(/\s+/g, ' ').trim());
  const items = [];
  lines.forEach((l, i) => {
    const m = l.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(used|left)/i);
    if (!m) return;
    let label = l.slice(0, m.index).trim();
    if (!/[a-z]/i.test(label)) label = (lines.slice(Math.max(0, i - 2), i).reverse().find((x) => /[a-z]/i.test(x)) || '').trim();
    const reset = (l + ' ' + (lines[i + 1] || '')).match(/resets?\s+([^·|]+)/i);
    let pct = Number(m[1]);
    if (/left/i.test(m[2] || '')) pct = 100 - pct;
    if (pct > 100 || !label) return;
    items.push({ label: label.replace(/[:·]+$/, '').slice(0, 60), percentUsed: pct, resets: reset ? reset[1].trim().slice(0, 50) : null });
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
      const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
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
      const tokens = (u.input_tokens || 0) - (u.cached_input_tokens || 0) + (u.output_tokens || 0);
      add(stats, seen, o.timestamp, tokens, f, project);
    });
  }
  return stats;
}

module.exports = { captureCli, parseUsage, claudeStats, codexStats };
