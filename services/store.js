// Tiny JSON store in Electron's userData folder (settings, window, tabs, favorites).
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: {
    projectsRoot: '~/claude-projects',
    defaultModel: '',
    accent: '#b4a5f0',
    env: { claude: '', codex: '', gemini: '', ollama: '', shell: '' }, // "KEY=value" per line
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
  if (data.settings.accent === "#22d3ee") data.settings.accent = DEFAULTS.settings.accent; // old default from the v1 theme
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
