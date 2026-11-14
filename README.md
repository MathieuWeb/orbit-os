# AI Terminal

A command center for Claude Code, Codex and local Ollama models, in real terminals (Electron + xterm.js + node-pty).

## Run

```bash
npm install && npm start
```

`npm install` tries to rebuild node-pty for Electron. If your compiler is broken (as it is right now with
Command Line Tools vs the macOS 27 SDK), it falls back to node-pty's prebuilt N-API binary, which works fine.

`npm test` checks the model-picking math and the usage parser, and prints the model picked for this Mac.

## Make it a real app (Applications folder)

```bash
npm run install:app
```

Builds, signs locally (ad hoc) and installs `/Applications/AI Terminal.app`. Run it again after any code change.

## Layout of the code

```
main.js              window, terminals (node-pty), IPC, presets
preload.js           the safe bridge the UI talks through
renderer/            index.html, style.css, app.js (UI, plain JS)
services/
  projects.js        lists + watches ~/claude-projects
  usage.js           /usage and /status capture (hidden terminal) + token counts from local logs
  modelFinder.js     hardware detection, best-model pick, catalog refresh from registry.ollama.ai
  system.js          RAM/CPU, installed-tool checks, Ollama API
  store.js           settings/tabs saved in ~/Library/Application Support/AI Terminal/state.json
models.json          catalog of abliterated coding models (tag, size, score)
```

## Add a preset

1. In `main.js`, add an entry to `PRESETS`:
   ```js
   aider: { label: 'Aider', bin: 'aider', cmd: () => 'aider' },
   ```
2. In `renderer/app.js`, add an icon to `ICONS.aider`, a line to `DESC.aider`, and add `'aider'` to the
   `order` array in `openLauncher` (and to the quick-launch list in `renderHome` if you want it there).
3. Optional: add `aider: ''` to `env` in `services/store.js` so it gets its own env-vars box in Settings.

## Privacy

The app never opens credential files. It only launches the official CLIs. From session logs it keeps
token counts, timestamps and the project folder name, never message content.
