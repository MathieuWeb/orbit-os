// Tiny JSON store in Electron's userData folder (settings, window, tabs, favorites).
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: {
    projectsRoot: '~/claude-projects',
    defaultModel: '',
    accent: '#22d3ee',
    env: { claude: '', codex: '', ollama: '', shell: '' }, // "KEY=value" per line
  },
  window: { width: 1440, height: 900 },
  tabs: [],
  lastAi: {},
  favorites: [],
};

module.exports = function createStore(dir) {
  const file = path.join(dir, 'state.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
  data = { ...DEFAULTS, ...data, settings: { ...DEFAULTS.settings, ...data.settings, env: { ...DEFAULTS.settings.env, ...(data.settings || {}).env } } };
  let timer;
  return {
    get: (k) => data[k],
    set(k, v) {
      data[k] = v;
      clearTimeout(timer);
      timer = setTimeout(() => fs.writeFileSync(file, JSON.stringify(data, null, 2)), 300);
    },
    flush() { clearTimeout(timer); fs.writeFileSync(file, JSON.stringify(data, null, 2)); },
  };
};
