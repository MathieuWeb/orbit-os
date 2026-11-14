// Rebuild node-pty for Electron; if the local compiler is broken, fall back to node-pty's
// prebuilt N-API binary (N-API is ABI-stable, so it loads in Electron without rebuilding).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pty = path.join(__dirname, '..', 'node_modules', 'node-pty');
try {
  execSync('npx electron-rebuild -f -w node-pty', { stdio: 'inherit' });
} catch {
  console.warn('\n[Orbit OS] electron-rebuild failed, using node-pty prebuilt binary instead.\n');
  fs.rmSync(path.join(pty, 'build'), { recursive: true, force: true });
}
// npm drops the exec bit on spawn-helper, which makes every spawn fail with "posix_spawnp failed".
for (const dir of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
  const helper = path.join(pty, dir, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
