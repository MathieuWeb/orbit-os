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

// Live limits: Claude status line JSON and Codex rollout tail.
const { claudeLive, codexLive } = require('../services/usage');
const cl = claudeLive({ rate_limits: { five_hour: { used_percentage: 42.4, resets_at: 1893456000 }, seven_day: { used_percentage: 61 } } });
assert.deepStrictEqual(cl.map((i) => [i.label, i.percentUsed]), [['Current session (5 h)', 42], ['Current week', 61]]);
assert.ok(cl[0].resets && cl[1].resets === null);
assert.deepStrictEqual(claudeLive({}), []);
const fsx = require('fs'), osx = require('os'), px = require('path');
const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), 'codex-'));
fsx.writeFileSync(px.join(dir, 'r.jsonl'), [
  JSON.stringify({ timestamp: '2026-11-14T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } } }),
  JSON.stringify({ timestamp: '2026-11-14T11:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 18, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 86, window_minutes: 10080 } } } }),
].join('\n') + '\n');
const cx = codexLive(dir);
assert.deepStrictEqual(cx.items.map((i) => [i.label, i.percentUsed]), [['5 h limit', 18], ['Weekly limit', 86]]);
assert.strictEqual(codexLive(px.join(dir, 'none')), null);

const { APP_RE } = require('../services/system');
assert.strictEqual('/Applications/Google Chrome.app/Contents/Frameworks/x/Helpers/Google Chrome Helper.app/Contents/MacOS/h'.match(APP_RE)[1], 'Google Chrome');
assert.strictEqual('/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock'.match(APP_RE), null);

const hw = detectHardware();
const res = pick(catalog, hw.usableGB);
console.log(`Hardware: ${hw.chip}, ${hw.ramGB.toFixed(0)} GB RAM, ${hw.usableGB.toFixed(1)} GB usable`);
console.log(`Top pick: ${res.top && res.top.name} (${res.top && res.top.tag})`);
console.log(`Runners-up: ${res.runnersUp.map((m) => m.name).join(', ')}`);
console.log(`Too big example: ${res.tooBig && res.tooBig.name}`);
console.log('All checks passed.');

// Gemini /stats "Usage left" table -> percent used per model.
const gem = parseUsage('Model Usage   Reqs   Usage left\ngemini-2.5-pro   12   93.4% (Resets in 20h 3m)\ngemini-2.5-flash  3  100.0% (Resets in 20h 3m)');
assert.deepStrictEqual(gem.map((x) => [x.label, x.percentUsed, x.resets]), [['gemini-2.5-pro', 6.6, 'in 20h 3m'], ['gemini-2.5-flash', 0, 'in 20h 3m']]);
console.log('Gemini usage parse OK');

// Direct usage APIs: real response shapes -> meters.
const { claudeApiItems, codexApiItems } = require('../services/usage');
const ca = claudeApiItems({ five_hour: { utilization: 41.0, resets_at: '2026-11-14T15:49:59+00:00' }, seven_day: { utilization: 23.0, resets_at: '2026-11-16T03:59:59+00:00' }, seven_day_opus: null });
assert.deepStrictEqual(ca.map((x) => [x.label, x.percentUsed]), [['Current session (5 h)', 41], ['Current week (all models)', 23]]);
assert.ok(ca[0].resets);
const cx2 = codexApiItems({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 600 }, secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1763700000 } } });
assert.deepStrictEqual(cx2.map((x) => [x.label, x.percentUsed]), [['5 h limit', 12], ['Weekly limit', 3]]);
assert.deepStrictEqual(claudeApiItems(null), []);
assert.deepStrictEqual(codexApiItems({}), []);
console.log('Usage API parse OK');
