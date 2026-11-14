// Run: npm test  (plain node, no Electron needed)
const assert = require('assert');
const { pick, usableMemory, detectHardware } = require('../services/modelFinder');
const catalog = require('../models.json').models;

// 16 GB Mac -> about 8.4 GB usable.
assert.strictEqual(+usableMemory(16).toFixed(1), 8.4);

// Fit rule: size + 1.5 <= usable; highest score wins; tie -> smaller file.
const fake = [
  { name: 'A', sizeGB: 6.9, score: 7 },  // 8.4 needed, fits exactly
  { name: 'B', sizeGB: 5, score: 7 },    // same score, smaller -> wins
  { name: 'C', sizeGB: 7, score: 9 },    // 8.5 needed -> too big
  { name: 'D', sizeGB: 2, score: 3 },
];
const r = pick(fake, 8.4);
assert.strictEqual(r.top.name, 'B');
assert.deepStrictEqual(r.runnersUp.map((m) => m.name), ['A', 'D']);
assert.strictEqual(r.tooBig.name, 'C');
assert.strictEqual(pick(fake, 1).top, undefined);

// Every catalog entry is well-formed.
for (const m of catalog) {
  assert.ok(/^[\w.\-/:]+$/.test(m.tag), m.tag);
  assert.ok(m.sizeGB > 0 && m.score >= 1 && m.score <= 10, m.name);
}

const { parseUsage } = require('../services/usage');
const items = parseUsage('Current session\n████  15% used\nResets 4:49pm (Europe/Paris)\n\n49%  Turn off skills');
assert.deepStrictEqual(items, [{ label: 'Current session', percentUsed: 15, resets: '4:49pm (Europe/Paris)' }]);

const hw = detectHardware();
const res = pick(catalog, hw.usableGB);
console.log(`Hardware: ${hw.chip}, ${hw.ramGB.toFixed(0)} GB RAM, ${hw.usableGB.toFixed(1)} GB usable`);
console.log(`Top pick: ${res.top && res.top.name} (${res.top && res.top.tag})`);
console.log(`Runners-up: ${res.runnersUp.map((m) => m.name).join(', ')}`);
console.log(`Too big example: ${res.tooBig && res.tooBig.name}`);
console.log('All checks passed.');
