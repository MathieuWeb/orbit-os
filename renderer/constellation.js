/* Constellation card on the Home page: one glowing point per project file, recent work in the bright core.
   ES module loaded after app.js; uses its globals (S, openTab, openLauncher, installed, esc, toast). */
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const DAY = 864e5, R = 260;
const view = document.getElementById('cstView');
const q = (id) => document.getElementById('cst-' + id);
const nf = new Intl.NumberFormat('fr-FR');
const big = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' M' : n >= 1e4 ? Math.round(n / 1e3) + ' k' : nf.format(n);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Stable pseudo-random per file so the cloud keeps its shape between visits.
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const fib = (i, n) => { const y = 1 - (i + 0.5) / n * 2, r = Math.sqrt(1 - y * y), a = i * 2.39996; return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r); };

let renderer, scene, camera, bgScene, bgCam, controls, cloud, points, uniforms, data, now, projects = [], pts = [];
let hoverIdx = -1, sel = -1, down = null, flyTo = null, running = false, clockTimer = 0;
const HOME = new THREE.Vector3(0, 60, 620);
const clock = new THREE.Clock();
const ago = (t) => { const d = (now - t) / DAY; return d < 1 / 24 ? 'maintenant' : d < 1 ? Math.round(d * 24) + ' h' : Math.round(d) + ' j'; };

function setup() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x07050a);
  q('canvas').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x07050a, 500, 1500);
  camera = new THREE.PerspectiveCamera(55, 1, 0.5, 5000);
  camera.position.copy(HOME);
  controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.06, minDistance: 5, maxDistance: 1400, zoomSpeed: 0.8 });
  controls.addEventListener('start', () => (flyTo = null));
  const grid = new THREE.GridHelper(3200, 80, 0x8d3a5a, 0x3a1828);
  grid.position.y = -210; grid.material.transparent = true; grid.material.opacity = 0.55;
  // The floor grid lives in its own scene with a camera that never moves, so it stays put while you orbit the cloud.
  bgScene = new THREE.Scene(); bgScene.fog = scene.fog; bgScene.add(grid);
  bgCam = camera.clone(); bgCam.lookAt(0, 0, 0);
  renderer.autoClear = false;
  uniforms = { uTime: { value: 0 }, uSel: { value: -1 }, uHover: { value: -1 }, uScale: { value: 1 } };
  new ResizeObserver(resize).observe(view);
  // On the scrolling Home page a plain wheel scrolls the page; pinch (ctrlKey) or ⌘+wheel zooms the cloud.
  q('canvas').addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); }, { capture: true });
  bindEvents();
}

function build() {
  if (cloud) { scene.remove(cloud); cloud.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); o.material?.map?.dispose(); }); }
  cloud = new THREE.Group(); cloud.position.y = 20; scene.add(cloud);
  now = data.now;
  projects = data.projects.filter((p) => p.files.length);
  projects.forEach((p, k) => (p.k = k));
  pts = [];
  projects.forEach((p) => {
    const dir = fib(p.k, projects.length);
    for (const f of p.files) {
      const r = rng(hash(p.name + '/' + f.f));
      const age = Math.min(1, Math.log1p(Math.max(0, (now - f.t) / DAY)) / Math.log1p(150));
      // Recent work sinks to the bright core, old files drift to the shell.
      const v = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize().multiplyScalar(0.55 + r() * 0.5).add(dir).normalize()
        .multiplyScalar(R * (0.08 + 0.92 * Math.pow(age, 0.8)) * (0.85 + r() * 0.3));
      pts.push({ v, k: p.k, f: f.f, t: f.t, age, tw: r() * 6.28 });
    }
  });

  const N = pts.length;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), proj = new Float32Array(N), tw = new Float32Array(N);
  const hot = new THREE.Color(0xfff0f5), warm = new THREE.Color(0xf07fa3), cold = new THREE.Color(0xb04a78), c = new THREE.Color();
  pts.forEach((p, i) => {
    pos.set([p.v.x, p.v.y, p.v.z], i * 3);
    if (p.age < 0.5) c.copy(hot).lerp(warm, p.age * 2); else c.copy(warm).lerp(cold, (p.age - 0.5) * 2);
    col.set([c.r, c.g, c.b], i * 3);
    size[i] = 3.4 + 5.5 * Math.pow(1 - p.age, 2); proj[i] = p.k; tw[i] = p.tw;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('proj', new THREE.BufferAttribute(proj, 1));
  geo.setAttribute('tw', new THREE.BufferAttribute(tw, 1));
  points = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float size; attribute float proj; attribute float tw; attribute vec3 color;
      uniform float uTime; uniform float uSel; uniform float uHover; uniform float uScale;
      varying vec3 vColor; varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float on = uSel < 0.0 || abs(proj - uSel) < 0.5 ? 1.0 : 0.12;
        float hv = abs(float(gl_VertexID) - uHover) < 0.5 ? 2.2 : 1.0;
        vColor = color; vAlpha = on * (0.75 + 0.25 * sin(uTime * 1.8 + tw));
        gl_PointSize = size * hv * uScale * (750.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, (a * a + smoothstep(0.12, 0.0, d)) * vAlpha);
      }`,
  }));
  cloud.add(points);

  // Links: each file to its 2 nearest neighbours in the same project.
  const seg = [], segProj = [];
  for (const p of projects) {
    const idx = []; pts.forEach((x, i) => x.k === p.k && idx.push(i));
    for (const i of idx) {
      const best = [[1e9, -1], [1e9, -1]];
      for (const j of idx) {
        if (j === i) continue;
        const d = pts[i].v.distanceToSquared(pts[j].v);
        if (d < best[1][0]) { best[1] = [d, j]; best.sort((a, b) => a[0] - b[0]); }
      }
      for (const [d, j] of best) if (j > i && d < 55 * 55) { seg.push(...pts[i].v.toArray(), ...pts[j].v.toArray()); segProj.push(p.k, p.k); }
    }
  }
  const lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  lgeo.setAttribute('proj', new THREE.Float32BufferAttribute(segProj, 1));
  cloud.add(new THREE.LineSegments(lgeo, new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float proj; uniform float uSel; varying float vA;
      void main() { vA = uSel < 0.0 ? 0.2 : abs(proj - uSel) < 0.5 ? 0.5 : 0.03; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vA; void main() { gl_FragColor = vec4(0.91, 0.45, 0.6, vA); }`,
  })));

  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const x = cv.getContext('2d'), g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,200,220,.55)'); g.addColorStop(0.4, 'rgba(200,70,120,.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.scale.setScalar(R * 2.6); cloud.add(glow);

  select(-1);
  hud();
}

function pick(e) {
  const b = renderer.domElement.getBoundingClientRect();
  const ptr = new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.params.Points.threshold = Math.max(2, camera.position.distanceTo(controls.target) / 120);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(points).find((h) => sel < 0 || pts[h.index].k === sel);
  return hit ? hit.index : -1;
}

function bindEvents() {
  const el = renderer.domElement, tip = q('tip');
  el.addEventListener('pointermove', (e) => {
    if (!points) return;
    const i = pick(e);
    hoverIdx = i; uniforms.uHover.value = i;
    q('canvas').classList.toggle('hover', i >= 0);
    if (i < 0) return tip.classList.remove('show');
    const x = pts[i];
    tip.innerHTML = `<b>${esc(projects[x.k].name)}</b> / ${esc(x.f)}<br><span class="cst-cap">modifié il y a ${ago(x.t)}</span>`;
    tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
    tip.classList.add('show');
  });
  el.addEventListener('pointerleave', () => { tip.classList.remove('show'); hoverIdx = -1; uniforms.uHover.value = -1; });
  el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
  el.addEventListener('pointerup', (e) => {
    if (!points || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return; // a drag, not a click
    const i = pick(e);
    select(i >= 0 ? pts[i].k : -1, true);
  });
  el.addEventListener('dblclick', (e) => { const i = pick(e); if (i >= 0) launch(projects[pts[i].k]); });
  q('reset').onclick = () => { select(-1); flyTo = { target: new THREE.Vector3(), cam: HOME.clone() }; };
  view.addEventListener('keydown', (e) => e.key === 'Escape' && q('reset').click());
  q('proj').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) select(+b.dataset.k === sel ? -1 : +b.dataset.k, true); });
}

function select(k, fly) {
  sel = k; uniforms.uSel.value = k;
  view.querySelectorAll('.cst-proj button').forEach((b) => b.classList.toggle('on', +b.dataset.k === k));
  if (k < 0) { q('detail').innerHTML = '<p class="cst-cap">Survole un point · clique un projet</p>'; return; }
  const p = projects[k];
  if (fly) {
    const ctr = new THREE.Vector3(); let n = 0;
    pts.forEach((x) => x.k === k && (ctr.add(x.v), n++));
    const world = cloud.localToWorld(ctr.divideScalar(n));
    flyTo = { target: world, cam: world.clone().add(camera.position.clone().sub(controls.target).setLength(240)) };
  }
  const last = lastAi(p);
  q('detail').innerHTML = `<div class="name">${esc(p.name)}</div><dl>
    <dt>Dernière modif</dt><dd>${ago(p.last)}</dd>
    <dt>Fichiers touchés 7 j</dt><dd>${nf.format(p.week)}</dd>
    <dt>Fichiers au total</dt><dd>${nf.format(p.total)}</dd>
    <dt>Tokens Claude 7 j</dt><dd>${big(p.claude)}</dd>
    <dt>Sessions Codex 7 j</dt><dd>${p.codex}</dd>
    <dt>Dernière IA</dt><dd>${last ? esc(S.presets[last]?.label || last) : '—'}</dd></dl>
    <button class="cst-btn" type="button" id="cst-open">${last && installed(last) ? 'Ouvrir ' + esc(S.presets[last].label) : 'Ouvrir…'}</button>`;
  q('open').onclick = () => launch(p);
}

// The app's own record (tabs opened from Orbit OS) wins over what the logs say.
const lastAi = (p) => S.lastAi[p.name] || p.lastAi;
function launch(p) {
  const project = S.projects.projects.find((x) => x.name === p.name) || { name: p.name, path: p.path };
  const last = lastAi(p);
  if (last && installed(last)) openTab({ preset: last, cwd: project.path, project: project.name });
  else openLauncher(project);
}

function hud() {
  const sorted = [...projects].sort((a, b) => b.last - a.last);
  q('projCount').textContent = projects.length;
  q('proj').innerHTML = sorted.map((p) => `<button type="button" data-k="${p.k}"><span>${esc(p.name)}</span><span>${ago(p.last)}</span></button>`).join('');
  const spark = (vals) => {
    const max = Math.max(1, ...vals), w = 240, h = 22;
    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${(i / (vals.length - 1) * w).toFixed(1)} ${(h - 2 - v / max * (h - 4)).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="#e8829f" stroke-width="1.2" opacity=".85"/></svg>`;
  };
  const perDay = Array.from({ length: 14 }, (_, i) => pts.filter((x) => Math.floor((now - x.t) / DAY) === 13 - i).length);
  const sum = (k) => projects.reduce((s, p) => s + p[k], 0);
  const weekFiles = sum('week'), active = projects.filter((p) => now - p.last < 7 * DAY).length;
  const vital = (label, v, unit, side, series) => `<div class="cst-vital"><div class="row cst-cap"><span>${label}</span><span>${side}</span></div><div class="v">${v}${unit ? ` <small>${unit}</small>` : ''}</div>${series ? spark(series) : ''}</div>`;
  q('vitals').innerHTML = vital('Fichiers touchés', nf.format(weekFiles), '', '14 j', perDay)
    + vital('Tokens Claude', big(sum('claude')), '', 'hors cache')
    + vital('Projets actifs', active, `/ ${projects.length}`, '')
    + vital('Sessions Codex', sum('codex'), '', '');
  q('recent').innerHTML = pts.slice().sort((a, b) => b.t - a.t).slice(0, 7)
    .map((x) => `<li><span>${esc(x.f.split('/').pop())}</span><span>${esc(projects[x.k].name)} · ${ago(x.t)}</span></li>`).join('');
  const top = [...projects].sort((a, b) => b.week - a.week)[0];
  if (!top) return;
  const share = Math.round(top.week / Math.max(1, weekFiles) * 100);
  q('topName').textContent = top.name;
  q('bigNum').innerHTML = `${nf.format(top.week)}<small>FICHIERS · 7 J</small>`;
  q('bar').style.width = share + '%';
  q('focusMeta').innerHTML = `<span>Part <b>${share} %</b></span><span>Tokens <b>${big(top.claude)}</b></span><span>Modifié <b>${ago(top.last)}</b></span>`;
  q('status').innerHTML = `<span>Core · live</span><span>Projets · ${projects.length}</span><span>Fichiers · ${nf.format(pts.length)}</span>`;
}

function tick() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  q('clock').innerHTML = `${p(d.getHours())}:${p(d.getMinutes())}<i>:${p(d.getSeconds())}</i>`;
  q('date').textContent = d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });
}

function resize() {
  if (!renderer || !view.clientWidth) return;
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h); camera.aspect = bgCam.aspect = w / h; camera.updateProjectionMatrix(); bgCam.updateProjectionMatrix();
  uniforms.uScale.value = Math.min(devicePixelRatio, 2) * h / 900;
}

function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  uniforms.uTime.value = clock.elapsedTime;
  if (!reduce && hoverIdx < 0 && sel < 0) cloud.rotation.y += dt * 0.06;
  if (flyTo) {
    controls.target.lerp(flyTo.target, 0.07);
    camera.position.lerp(flyTo.cam, 0.07);
    if (camera.position.distanceTo(flyTo.cam) < 1) flyTo = null;
  }
  controls.update();
  renderer.clear(); renderer.render(bgScene, bgCam); renderer.clearDepth(); renderer.render(scene, camera);
}

// Render only while the view is on screen, so terminals keep the CPU/GPU.
async function start() {
  if (running) return;
  running = true;
  if (!renderer) setup();
  resize(); tick(); clockTimer = setInterval(tick, 1000);
  clock.getDelta();
  renderer.setAnimationLoop(() => cloud && frame());
  try {
    const fresh = await api.constellation();
    if (!fresh || !fresh.projects.length) { q('empty').hidden = false; return; }
    q('empty').hidden = true;
    if (!data || fresh.now !== data.now) { data = fresh; build(); }
  } catch (e) { toast('Constellation : ' + (e.message || e)); }
}
function stop() {
  running = false; clearInterval(clockTimer);
  renderer?.setAnimationLoop(null);
  q('tip').classList.remove('show');
}
new MutationObserver(() => (document.body.dataset.view === 'dash' ? start() : stop())).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
if (document.body.dataset.view === 'dash') start();
