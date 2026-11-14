// Lists and watches the subfolders of the projects root.
const fs = require('fs');
const path = require('path');
const os = require('os');

const expand = (p) => p.replace(/^~(?=$|\/)/, os.homedir());

function list(root) {
  const dir = expand(root);
  if (!fs.existsSync(dir)) return { exists: false, dir, projects: [] };
  const projects = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { exists: true, dir, projects };
}

// Calls onChange(list) whenever folders appear/disappear. Returns a stop function.
function watch(root, onChange) {
  const dir = expand(root);
  let watcher, timer, poll;
  const emit = () => { clearTimeout(timer); timer = setTimeout(() => onChange(list(root)), 200); };
  const start = () => {
    try {
      watcher = fs.watch(dir, emit);
      watcher.on('error', () => { watcher.close(); watcher = null; waitForDir(); });
    } catch { waitForDir(); }
  };
  // Folder missing (or deleted): check every 3 s until it exists again.
  const waitForDir = () => {
    clearInterval(poll);
    poll = setInterval(() => { if (fs.existsSync(dir)) { clearInterval(poll); emit(); start(); } }, 3000);
  };
  start();
  return () => { watcher && watcher.close(); clearInterval(poll); clearTimeout(timer); };
}

module.exports = { list, watch, expand };
