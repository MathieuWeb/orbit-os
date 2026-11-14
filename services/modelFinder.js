// Hardware detection + picks the best local coding model that fits in memory.
const { execFileSync } = require('child_process');
const https = require('https');

const CONTEXT_GB = 1.5;

function detectHardware() {
  const sysctl = (k) => execFileSync('/usr/sbin/sysctl', ['-n', k], { encoding: 'utf8' }).trim();
  const ramGB = Number(sysctl('hw.memsize')) / 1024 ** 3;
  let chip = 'Unknown chip';
  try { chip = sysctl('machdep.cpu.brand_string'); } catch {}
  return { ramGB, chip, usableGB: usableMemory(ramGB) };
}

// ~65% of RAM is what macOS lets the GPU use comfortably; keep ~2 GB for the system and apps.
const usableMemory = (ramGB) => Math.max(0, ramGB * 0.65 - 2);

function pick(catalog, usableGB) {
  const withFit = catalog.map((m) => ({ ...m, needGB: +(m.sizeGB + CONTEXT_GB).toFixed(1), fits: m.sizeGB + CONTEXT_GB <= usableGB }));
  const ranked = withFit.filter((m) => m.fits).sort((a, b) => b.score - a.score || a.sizeGB - b.sizeGB);
  const tooBig = withFit.filter((m) => !m.fits).sort((a, b) => a.sizeGB - b.sizeGB)[0] || null;
  const why = (m) => m.fits
    ? `${m.sizeGB} GB file + ${CONTEXT_GB} GB working memory = ${m.needGB} GB, fits in your ${usableGB.toFixed(1)} GB. Coding score ${m.score}/10.`
    : `Needs ${m.needGB} GB but your Mac can spare about ${usableGB.toFixed(1)} GB.`;
  const tag = (m) => m && { ...m, reason: why(m) };
  return { top: tag(ranked[0]), runnersUp: ranked.slice(1, 3).map(tag), tooBig: tag(tooBig) };
}

// Asks the Ollama registry whether each tag exists and how big it really is.
function manifest(tag) {
  const [repo, ver = 'latest'] = tag.split(':');
  const url = `https://registry.ollama.ai/v2/${repo.includes('/') ? repo : 'library/' + repo}/manifests/${ver}`;
  return new Promise((resolve) => {
    https.get(url, { headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' }, timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body).layers.reduce((s, l) => s + l.size, 0) / 1e9); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); });
  });
}

async function refreshCatalog(catalog) {
  return Promise.all(catalog.map(async (m) => {
    const gb = await manifest(m.tag);
    return gb == null ? { ...m, verified: false } : { ...m, sizeGB: +gb.toFixed(1), verified: true, checked: new Date().toISOString().slice(0, 10) };
  }));
}

module.exports = { detectHardware, usableMemory, pick, refreshCatalog, CONTEXT_GB };
