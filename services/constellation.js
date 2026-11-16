// Data for the Constellation view: every file of every project (name + mtime only), plus
// per-project Claude tokens and Codex sessions from local logs. Nothing is read inside files
// except the log lines' cwd, timestamp and token counts.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DAY = 864e5;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'venv', '.venv', '__pycache__']);
const PER_PROJECT = 220; // shortcut: most recent files only, keeps the 3D cloud fluid; raise if it stays smooth

function walk(dir, base, depth, acc, since) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 6) walk(p, base, depth + 1, acc, since); continue; }
    try {
      const t = Math.round(fs.statSync(p).mtimeMs);
      if (t > acc.last) acc.last = t;
      if (t > since) acc.week++;
      acc.files.push({ f: path.relative(base, p), t });
    } catch {}
  }
  return acc;
}

function readLines(file, fn) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) fn(line);
}

function collect(root, home = os.homedir(), now = Date.now()) {
  const since = now - 7 * DAY;
  try { root = fs.realpathSync.native(root); } catch {} // true on-disk case: log cwds use it, the setting may not
  let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return { now, projects: [] }; }
  const projects = dirs.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => {
    const p = path.join(root, d.name);
    return { name: d.name, path: p, ...walk(p, p, 0, { last: 0, week: 0, files: [] }, since), claude: 0, codex: 0, lastAi: null, lastAiAt: 0 };
  });
  const byCwd = (cwd) => cwd && projects.find((p) => cwd === p.path || cwd.startsWith(p.path + '/'));
  const seen = (p, ai, t) => { if (t > p.lastAiAt) { p.lastAiAt = t; p.lastAi = ai; } };

  // Claude Code: each log line carries cwd; assistant lines carry usage.
  const cdir = path.join(home, '.claude', 'projects');
  for (const d of fs.existsSync(cdir) ? fs.readdirSync(cdir) : []) {
    let files; try { files = fs.readdirSync(path.join(cdir, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(cdir, d, f);
      try { if (fs.statSync(fp).mtimeMs < now - 40 * DAY) continue; } catch { continue; }
      readLines(fp, (line) => {
        if (!line.includes('"cwd"')) return;
        let o; try { o = JSON.parse(line); } catch { return; }
        const p = byCwd(o.cwd); if (!p) return;
        const t = Date.parse(o.timestamp) || 0;
        seen(p, 'claude', t);
        const u = o.message && o.message.usage;
        if (u && t > since) p.claude += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      });
    }
  }

  // Codex: the first line (session_meta) holds the cwd; count sessions.
  (function codex(dir) {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { codex(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try {
        const o = JSON.parse(fs.readFileSync(p, 'utf8').split('\n', 1)[0]), pl = o.payload || {};
        const proj = byCwd(pl.cwd); if (!proj) continue;
        const t = Date.parse(pl.timestamp || o.timestamp) || fs.statSync(p).mtimeMs;
        seen(proj, 'codex', t);
        if (t > since) proj.codex++;
      } catch {}
    }
  })(path.join(home, '.codex', 'sessions'));

  return {
    now,
    projects: projects.map(({ name, path: p, last, week, claude, codex, lastAi, files }) => ({
      name, path: p, last, week, claude, codex, lastAi, total: files.length,
      files: files.sort((a, b) => b.t - a.t).slice(0, PER_PROJECT),
    })),
  };
}

module.exports = { collect };
