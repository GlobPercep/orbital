import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

/* ORBITAL — live satellite tracker.
   TLEs from CelesTrak (fetched at most every 2 h, cached in localStorage);
   positions computed client-side with SGP4 (satellite.js). Full SGP4 passes
   are staggered across frames; between passes each satellite is linearly
   extrapolated from its last ECI position + velocity, which is visually
   exact at these time scales and keeps 12k satellites at 60 fps. */

const KM = 1 / 1000;                    // scene scale: 1 unit = 1000 km
const EARTH_R_KM = 6371;
const EARTH_R = EARTH_R_KM * KM;
const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';
const CACHE_KEY = 'orbital_tle_v1';
const TLE_MAX_AGE = 2 * 3600 * 1000;

const CATS = [
  { id: 'station',  label: 'Stations', color: '#ff5f5f', test: n => /ZARYA|TIANHE/.test(n) },
  { id: 'starlink', label: 'Starlink', color: '#46c8ff', test: n => n.startsWith('STARLINK') },
  { id: 'oneweb',   label: 'OneWeb',   color: '#a78bfa', test: n => n.startsWith('ONEWEB') },
  { id: 'gnss',     label: 'GNSS',     color: '#ffc14d', test: n => /NAVSTAR|GLONASS|GALILEO|GSAT0|BEIDOU|QZS|IRNSS|NVS-/.test(n) },
  { id: 'other',    label: 'Other',    color: '#8fa3bf', test: () => true },
];

/* ---------------- renderer / scene ---------------- */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02040a);
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 1200);
camera.position.set(11, 6.5, 15);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 7.1;
controls.maxDistance = 90;
controls.rotateSpeed = 0.55;
controls.enablePan = false;

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/* ---------------- earth ---------------- */
const texLoader = new THREE.TextureLoader();
const dayTex = texLoader.load('textures/earth_atmos_2048.jpg');
const nightTex = texLoader.load('textures/earth_lights_2048.png');
dayTex.colorSpace = nightTex.colorSpace = THREE.SRGBColorSpace;
dayTex.anisotropy = nightTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

const earthMat = new THREE.ShaderMaterial({
  uniforms: {
    dayMap: { value: dayTex },
    nightMap: { value: nightTex },
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    varying vec3 vN;
    void main() {
      vUv = uv;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D dayMap, nightMap;
    uniform vec3 sunDir;
    varying vec2 vUv;
    varying vec3 vN;
    void main() {
      vec3 day = texture2D(dayMap, vUv).rgb;
      vec3 night = texture2D(nightMap, vUv).rgb;
      float nd = dot(normalize(vN), sunDir);
      float dayside = smoothstep(-0.12, 0.18, nd);
      vec3 lit = day * (0.25 + 0.85 * clamp(nd, 0.0, 1.0));
      vec3 dark = night * vec3(1.0, 0.85, 0.62) * 1.6 + day * 0.02;
      gl_FragColor = vec4(mix(dark, lit, dayside), 1.0);
    }`,
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 96, 64), earthMat);
scene.add(earth);

const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_R * 1.045, 64, 48),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      varying vec3 vN, vPos;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vN, vPos;
      void main() {
        vec3 v = normalize(cameraPosition - vPos);
        float rim = pow(1.0 - abs(dot(v, normalize(vN))), 3.5);
        gl_FragColor = vec4(vec3(0.25, 0.55, 1.0) * rim * 1.1, 1.0);
      }`,
  })
);
scene.add(atmosphere);

/* ---------------- stars ---------------- */
{
  const n = 3200;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(500 + Math.random() * 300);
    p.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x9fb4d8, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.75,
  })));
}

/* ---------------- satellite points ---------------- */
function makeGlowSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const glowTex = makeGlowSprite();

let satPoints = null;      // THREE.Points
let posAttr = null;        // its position attribute

/* selection visuals */
const selMarker = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTex, color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.95,
}));
selMarker.scale.setScalar(0.5);
selMarker.visible = false;
scene.add(selMarker);

const ORBIT_N = 256;
const orbitGeom = new THREE.BufferGeometry();
orbitGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBIT_N * 3), 3));
const orbitLine = new THREE.Line(orbitGeom, new THREE.LineBasicMaterial({
  color: 0xffffff, transparent: true, opacity: 0.55,
}));
orbitLine.visible = false;
scene.add(orbitLine);

const FOOT_N = 96;
const footGeom = new THREE.BufferGeometry();
footGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FOOT_N * 3), 3));
const footLine = new THREE.LineLoop(footGeom, new THREE.LineBasicMaterial({
  color: 0x46c8ff, transparent: true, opacity: 0.7,
}));
footLine.visible = false;
scene.add(footLine);

/* ---------------- satellite data ---------------- */
let N = 0;
let names = [], satrecs = [], satnums = [];
let cat = null;            // Uint8Array — index into CATS
let alive = null;          // Uint8Array
let eciP = null, eciV = null, epochMs = null;  // Float64Array
let tleFetchedAt = 0;
const catVisible = CATS.map(() => true);
const catCount = CATS.map(() => 0);
let selIdx = -1;
let orbitEci = null;       // Float64Array(ORBIT_N*3), km, snapshot of one period

const $ = id => document.getElementById(id);
const setLoad = (pct, msg) => { $('bar').style.width = pct + '%'; $('load-status').textContent = msg; };

async function fetchTLE() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); }
  catch { /* corrupt cache — refetch */ }
  if (cached && Date.now() - cached.t < TLE_MAX_AGE) {
    tleFetchedAt = cached.t;
    return cached.data;
  }
  try {
    const res = await fetch(TLE_URL);
    if (!res.ok) throw new Error('CelesTrak responded ' + res.status);
    const text = await res.text();
    tleFetchedAt = Date.now();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: tleFetchedAt, data: text })); }
    catch { /* quota exceeded — run uncached */ }
    return text;
  } catch (err) {
    // CelesTrak throttles repeat downloads per IP (~2 h); TLEs stay usable for
    // days, so fall back to any cached copy, then to the bundled snapshot.
    if (cached) {
      tleFetchedAt = cached.t;
      return cached.data;
    }
    const res = await fetch('tle-snapshot.txt');
    if (!res.ok) throw err;
    tleFetchedAt = Date.parse(res.headers.get('last-modified') || '') || Date.now() - TLE_MAX_AGE;
    return await res.text();
  }
}

function parseTLE(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      out.push([lines[i].trim(), lines[i + 1], lines[i + 2]]);
      i += 2;
    }
  }
  return out;
}

async function initSats(tles, quiet) {
  N = tles.length;
  names = new Array(N);
  satrecs = new Array(N);
  satnums = new Array(N);
  cat = new Uint8Array(N);
  alive = new Uint8Array(N);
  eciP = new Float64Array(N * 3);
  eciV = new Float64Array(N * 3);
  epochMs = new Float64Array(N);
  catCount.fill(0);

  const BATCH = 4000;
  for (let s = 0; s < N; s += BATCH) {
    const end = Math.min(s + BATCH, N);
    for (let i = s; i < end; i++) {
      const [name, l1, l2] = tles[i];
      names[i] = name;
      const rec = satellite.twoline2satrec(l1, l2);
      satrecs[i] = rec;
      satnums[i] = rec.satnum;
      alive[i] = rec.error ? 0 : 1;
      cat[i] = CATS.findIndex(c => c.test(name));
      catCount[cat[i]]++;
    }
    if (!quiet) setLoad(20 + 75 * (end / N), `initializing SGP4 · ${end.toLocaleString()} / ${N.toLocaleString()}`);
    await new Promise(r => setTimeout(r, 0));
  }
  buildGeometry();
  buildChips();
}

function buildGeometry() {
  if (satPoints) {
    scene.remove(satPoints);
    satPoints.geometry.dispose();
    satPoints.material.dispose();
  }
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);          // all start hidden at origin (inside Earth)
  const col = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    c.set(CATS[cat[i]].color);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // positions stream in each frame; a fixed sphere out past GEO keeps raycasting valid
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 120);
  posAttr = g.attributes.position;
  satPoints = new THREE.Points(g, new THREE.PointsMaterial({
    size: 0.075, map: glowTex, vertexColors: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  satPoints.frustumCulled = false;
  scene.add(satPoints);
}

/* ---------------- simulation clock ---------------- */
let simTime = Date.now();
let speed = 1;
let lastReal = performance.now();

/* ---------------- propagation ---------------- */
let cursor = 0;
function chunkSize() { return speed <= 30 ? 1500 : speed <= 120 ? 3000 : 4500; }

function propagateOne(i, date) {
  if (!alive[i] || !satrecs[i]) return;
  let pv;
  try { pv = satellite.propagate(satrecs[i], date); }
  catch { alive[i] = 0; return; }
  const p = pv && pv.position;
  if (!p || Number.isNaN(p.x)) { alive[i] = 0; return; }
  eciP[i * 3] = p.x; eciP[i * 3 + 1] = p.y; eciP[i * 3 + 2] = p.z;
  const v = pv.velocity;
  eciV[i * 3] = v.x; eciV[i * 3 + 1] = v.y; eciV[i * 3 + 2] = v.z;
  epochMs[i] = date.getTime();
}

function propagateChunk(date) {
  if (!N) return;
  const count = Math.min(chunkSize(), N);
  for (let k = 0; k < count; k++) {
    propagateOne(cursor, date);
    cursor = (cursor + 1) % N;
  }
}

/* ECI km -> scene units (ECEF frame mapped to three.js: x->x, z->y, y->-z) */
function writePositions(gmst) {
  if (!posAttr) return;
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const arr = posAttr.array;
  for (let i = 0; i < N; i++) {
    if (!alive[i] || !catVisible[cat[i]] || !epochMs[i]) {
      arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 0;   // parked inside the Earth
      continue;
    }
    const dt = (simTime - epochMs[i]) / 1000;
    const x = eciP[i * 3] + eciV[i * 3] * dt;
    const y = eciP[i * 3 + 1] + eciV[i * 3 + 1] * dt;
    const z = eciP[i * 3 + 2] + eciV[i * 3 + 2] * dt;
    arr[i * 3] = (x * cg + y * sg) * KM;
    arr[i * 3 + 1] = z * KM;
    arr[i * 3 + 2] = -(-x * sg + y * cg) * KM;
  }
  posAttr.needsUpdate = true;
}

/* ---------------- sun ---------------- */
const DEG = Math.PI / 180;
function updateSun(gmst) {
  const n = (simTime - 946728000000) / 86400000;   // days since J2000
  const L = (280.460 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = 23.439 * DEG;
  const x = Math.cos(lam), y = Math.cos(eps) * Math.sin(lam), z = Math.sin(eps) * Math.sin(lam);
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  earthMat.uniforms.sunDir.value.set(x * cg + y * sg, z, -(-x * sg + y * cg)).normalize();
}

/* ---------------- selection ---------------- */
function buildOrbit(i) {
  const rec = satrecs[i];
  const periodMin = (2 * Math.PI) / rec.no;
  orbitEci = new Float64Array(ORBIT_N * 3);
  for (let k = 0; k < ORBIT_N; k++) {
    const t = new Date(simTime + (k / (ORBIT_N - 1)) * periodMin * 60000);
    let pv;
    try { pv = satellite.propagate(rec, t); } catch { pv = null; }
    const p = pv && pv.position;
    if (p && !Number.isNaN(p.x)) orbitEci.set([p.x, p.y, p.z], k * 3);
    else orbitEci.set([NaN, NaN, NaN], k * 3);
  }
}

function updateSelectionVisuals(gmst) {
  if (selIdx < 0 || !alive[selIdx]) return;
  const i = selIdx;
  selMarker.position.set(posAttr.array[i * 3], posAttr.array[i * 3 + 1], posAttr.array[i * 3 + 2]);

  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const oa = orbitGeom.attributes.position.array;
  for (let k = 0; k < ORBIT_N; k++) {
    const x = orbitEci[k * 3], y = orbitEci[k * 3 + 1], z = orbitEci[k * 3 + 2];
    oa[k * 3] = (x * cg + y * sg) * KM;
    oa[k * 3 + 1] = z * KM;
    oa[k * 3 + 2] = -(-x * sg + y * cg) * KM;
  }
  orbitGeom.attributes.position.needsUpdate = true;

  // ground-coverage footprint (horizon circle) around the sub-satellite point
  const px = selMarker.position.x, py = selMarker.position.y, pz = selMarker.position.z;
  const r = Math.hypot(px, py, pz);
  if (r > EARTH_R) {
    const psi = Math.acos(EARTH_R / r);
    const ux = px / r, uy = py / r, uz = pz / r;
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(uy) > 0.9) { ax = 1; ay = 0; }
    let e1x = uy * az - uz * ay, e1y = uz * ax - ux * az, e1z = ux * ay - uy * ax;
    const l1 = Math.hypot(e1x, e1y, e1z); e1x /= l1; e1y /= l1; e1z /= l1;
    const e2x = uy * e1z - uz * e1y, e2y = uz * e1x - ux * e1z, e2z = ux * e1y - uy * e1x;
    const cp = Math.cos(psi), sp = Math.sin(psi), R = EARTH_R * 1.004;
    const fa = footGeom.attributes.position.array;
    for (let k = 0; k < FOOT_N; k++) {
      const a = (k / FOOT_N) * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
      fa[k * 3] = R * (cp * ux + sp * (ca * e1x + sa * e2x));
      fa[k * 3 + 1] = R * (cp * uy + sp * (ca * e1y + sa * e2y));
      fa[k * 3 + 2] = R * (cp * uz + sp * (ca * e1z + sa * e2z));
    }
    footGeom.attributes.position.needsUpdate = true;
  }
}

function select(i) {
  selIdx = i;
  if (i < 0) {
    selMarker.visible = orbitLine.visible = footLine.visible = false;
    $('info').style.display = 'none';
    return;
  }
  if (!catVisible[cat[i]]) toggleCat(cat[i]);   // reveal its group if hidden
  buildOrbit(i);
  const col = CATS[cat[i]].color;
  orbitLine.material.color.set(col);
  footLine.material.color.set(col);
  selMarker.material.color.set(col);
  selMarker.visible = orbitLine.visible = footLine.visible = true;
  $('info').style.display = 'block';
  $('info-name').textContent = names[selIdx];
  updateInfo(true);
}

let lastInfo = 0;
function updateInfo(force) {
  if (selIdx < 0) return;
  const now = performance.now();
  if (!force && now - lastInfo < 250) return;
  lastInfo = now;
  const i = selIdx, rec = satrecs[i];
  const dt = (simTime - epochMs[i]) / 1000;
  const x = eciP[i * 3] + eciV[i * 3] * dt;
  const y = eciP[i * 3 + 1] + eciV[i * 3 + 1] * dt;
  const z = eciP[i * 3 + 2] + eciV[i * 3 + 2] * dt;
  const gmst = satellite.gstime(new Date(simTime));
  const geo = satellite.eciToGeodetic({ x, y, z }, gmst);
  $('i-id').textContent = satnums[i];
  $('i-alt').textContent = geo.height.toFixed(0) + ' km';
  $('i-lat').textContent = (geo.latitude / DEG).toFixed(2) + '°';
  $('i-lon').textContent = (geo.longitude / DEG).toFixed(2) + '°';
  $('i-spd').textContent = Math.hypot(eciV[i * 3], eciV[i * 3 + 1], eciV[i * 3 + 2]).toFixed(2) + ' km/s';
  $('i-per').textContent = ((2 * Math.PI) / rec.no).toFixed(1) + ' min';
  $('i-inc').textContent = (rec.inclo / DEG).toFixed(1) + '°';
}
$('info-close').addEventListener('click', () => select(-1));

/* picking (shared by click and hover) */
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.09;
const earthSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), EARTH_R);
const occV = new THREE.Vector3();
const pickNdc = new THREE.Vector2();

function pickAt(clientX, clientY) {
  if (!satPoints) return -1;
  pickNdc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pickNdc, camera);
  const hits = raycaster.intersectObject(satPoints);
  for (const h of hits) {
    const i = h.index;
    if (!alive[i] || !catVisible[cat[i]] || !epochMs[i]) continue;
    const a = posAttr.array;
    if (a[i * 3] === 0 && a[i * 3 + 1] === 0 && a[i * 3 + 2] === 0) continue;  // hidden
    // skip satellites behind the Earth
    if (raycaster.ray.intersectSphere(earthSphere, occV) &&
        occV.distanceTo(raycaster.ray.origin) < h.distance) continue;
    return i;
  }
  return -1;
}

/* click-to-pick (ignore drags) */
let downX = 0, downY = 0;
canvas.addEventListener('pointerdown', e => { downX = e.clientX; downY = e.clientY; });
canvas.addEventListener('pointerup', e => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
  select(pickAt(e.clientX, e.clientY));
});

/* hover tooltip (mouse only — touch uses tap-to-select) */
const tooltip = $('tooltip');
const tooltipName = $('tooltip-name');
const tooltipDot = tooltip.querySelector('.dot');
let hoverX = 0, hoverY = 0, hoverDirty = false, lastHoverRun = 0;
canvas.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  hoverX = e.clientX; hoverY = e.clientY; hoverDirty = true;
  const now = performance.now();
  if (now - lastHoverRun > 30) { lastHoverRun = now; updateHover(); }
});
canvas.addEventListener('pointerleave', () => {
  tooltip.style.display = 'none';
  canvas.style.cursor = '';
});
window.__pick = pickAt;   // debug hook

function updateHover() {
  if (!hoverDirty) return;
  hoverDirty = false;
  const i = pickAt(hoverX, hoverY);
  if (i < 0) {
    tooltip.style.display = 'none';
    canvas.style.cursor = '';
    return;
  }
  tooltipName.textContent = names[i];
  const col = CATS[cat[i]].color;
  tooltipDot.style.color = tooltipDot.style.background = col;
  tooltip.style.display = 'flex';
  tooltip.style.left = Math.min(hoverX + 14, innerWidth - tooltip.offsetWidth - 8) + 'px';
  tooltip.style.top = Math.min(hoverY + 12, innerHeight - tooltip.offsetHeight - 8) + 'px';
  canvas.style.cursor = 'pointer';
}

/* ---------------- search ---------------- */
const searchEl = $('search'), resultsEl = $('search-results');
searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim().toUpperCase();
  resultsEl.innerHTML = '';
  if (q.length < 2) { resultsEl.style.display = 'none'; return; }
  let found = 0;
  for (let i = 0; i < N && found < 8; i++) {
    if (!alive[i] || !names[i].includes(q)) continue;
    const b = document.createElement('button');
    b.textContent = names[i];
    b.addEventListener('click', () => {
      select(i);
      resultsEl.style.display = 'none';
      searchEl.value = names[i];
      searchEl.blur();
    });
    resultsEl.appendChild(b);
    found++;
  }
  resultsEl.style.display = found ? 'block' : 'none';
});

/* ---------------- group chips ---------------- */
function toggleCat(ci) {
  catVisible[ci] = !catVisible[ci];
  document.querySelectorAll('.chip')[ci].classList.toggle('off', !catVisible[ci]);
  if (selIdx >= 0 && !catVisible[cat[selIdx]]) select(-1);
  updateStats();
}
function buildChips() {
  const box = $('groups');
  box.innerHTML = '';
  CATS.forEach((c, ci) => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (catVisible[ci] ? '' : ' off');
    chip.innerHTML = `<span class="dot" style="color:${c.color};background:${c.color}"></span>` +
      `${c.label} <span class="n">${catCount[ci].toLocaleString()}</span>`;
    chip.addEventListener('click', () => toggleCat(ci));
    box.appendChild(chip);
  });
}

/* ---------------- time controls ---------------- */
document.querySelectorAll('#speeds button').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.speed;
    if (v === 'live') { simTime = Date.now(); speed = 1; }
    else speed = Number(v);
    document.querySelectorAll('#speeds button').forEach(b =>
      b.classList.toggle('active', b.dataset.speed == (v === 'live' ? '1' : v)));
  });
});

/* ---------------- HUD ---------------- */
function updateStats() {
  let vis = 0;
  for (let ci = 0; ci < CATS.length; ci++) if (catVisible[ci]) vis += catCount[ci];
  const age = Math.max(0, Math.round((Date.now() - tleFetchedAt) / 60000));
  $('stats').textContent = `${vis.toLocaleString()} satellites · TLE age ${age} min`;
}
let lastHud = 0;
function updateHud() {
  const now = performance.now();
  if (now - lastHud < 250) return;
  lastHud = now;
  const d = new Date(simTime);
  $('clock-text').textContent = d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  $('live-dot').classList.toggle('on', speed === 1 && Math.abs(simTime - Date.now()) < 3000);
  updateStats();
}

/* ---------------- main loop ---------------- */
function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  simTime += (now - lastReal) * speed;
  lastReal = now;

  const date = new Date(simTime);
  const gmst = satellite.gstime(date);
  propagateChunk(date);
  writePositions(gmst);
  updateSun(gmst);
  if (selIdx >= 0) { updateSelectionVisuals(gmst); updateInfo(); }
  updateHover();
  updateHud();
  controls.update();
  renderer.render(scene, camera);
}

/* ---------------- TLE auto-refresh (every 2 h) ---------------- */
setInterval(async () => {
  if (Date.now() - tleFetchedAt < TLE_MAX_AGE) return;
  try {
    const prev = tleFetchedAt;
    const text = await fetchTLE();
    if (tleFetchedAt === prev) return;   // fallback returned the same old data
    const sel = selIdx >= 0 ? satnums[selIdx] : null;
    await initSats(parseTLE(text), true);
    cursor = 0;
    select(sel ? satnums.indexOf(sel) : -1);
  } catch { /* keep propagating from the old TLEs */ }
}, 10 * 60 * 1000);

/* ---------------- boot ---------------- */
async function boot() {
  $('load-error').style.display = $('retry').style.display = 'none';
  try {
    setLoad(5, 'contacting CelesTrak…');
    const text = await fetchTLE();
    setLoad(18, 'parsing TLE sets…');
    const tles = parseTLE(text);
    if (!tles.length) throw new Error('no TLE data received');
    await initSats(tles, false);
    setLoad(97, 'computing orbits…');
    const d = new Date(simTime);
    for (let i = 0; i < N; i++) propagateOne(i, d);
    writePositions(satellite.gstime(d));
    setLoad(100, 'ready');
    updateStats();
    $('loading').classList.add('done');
  } catch (err) {
    $('load-status').textContent = '';
    $('load-error').textContent = 'Could not load satellite data: ' + err.message;
    $('load-error').style.display = 'block';
    $('retry').style.display = 'inline-block';
  }
}
$('retry').addEventListener('click', boot);
boot();
tick();
