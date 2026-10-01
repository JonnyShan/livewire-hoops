// Bootstrap: renderer, quality tiers, menus, match setup, main loop.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { TEAMS, DIFFICULTY } from './data.js';
import { buildArena, RIM } from './arena.js';
import { Player, loadModel } from './player.js';
import { loadMotion, MOTION_URL } from './motion.js';
import { Ball, Net } from './ball.js';
import { Game } from './game.js';
import { Sound } from './audio.js';
import { Input } from './input.js';
import { installGrade, makeGradePass, loadArenaLight } from './look.js';
import { onProgress } from './progress.js';
import { Replay, shareClip } from './replay.js';

installGrade();

const $ = (id) => document.getElementById(id);

// ---------- settings ----------
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const settings = { quality: 'auto', sound: true, vib: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem('hardwood.settings') || '{}')); } catch (e) { /* storage blocked */ }
const save = () => { try { localStorage.setItem('hardwood.settings', JSON.stringify(settings)); } catch (e) { /* storage blocked */ } };
// the two players (fixed for now: no picker)
const HOME = TEAMS[0], AWAY = TEAMS[1];
const DIFF = DIFFICULTY.pro, GAME_TO = 11;
const qualityTier = () => settings.quality === 'auto' ? (isTouch ? 'med' : 'high') : settings.quality;
const modelUrl = (team) => (qualityTier() === 'low' && team.modelLo ? team.modelLo : team.model);
// the players are most of the download: start them the moment the page script runs
for (const t of [HOME, AWAY]) if (t.model && settings.models !== false) loadModel(modelUrl(t)).catch(() => {});
loadMotion(MOTION_URL).catch(() => {});

// ---------- renderer ----------
const canvas = $('gl');
let renderer, composer, bloom;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
camera.position.set(0, 4.5, 17);
camera.layers.enable(1);
const resolution = new THREE.Vector2(1, 1);

const basePixelRatio = (q = qualityTier()) => Math.min(window.devicePixelRatio || 1, q === 'high' ? 2 : q === 'med' ? 1.6 : 1);

function makeRenderer() {
  const q = qualityTier();
  if (renderer) renderer.dispose();
  renderer = new THREE.WebGLRenderer({ canvas, antialias: q !== 'low', powerPreference: 'high-performance', stencil: false });
  gov.scale = 1; gov.failed = 2; gov.trial = null; gov.holdUntil = 0;
  renderer.setPixelRatio(basePixelRatio(q));
  renderer.toneMapping = THREE.CustomToneMapping;      // ACES + broadcast grade (look.js)
  renderer.toneMappingExposure = 0.82;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = q !== 'low';
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // a neutral studio light until the arena photo has loaded
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  pmrem.dispose();
  look = null;
  const r = renderer;
  loadArenaLight(renderer, q).then((l) => { if (renderer === r) { look = l; applyLook(); } })
    .catch((e) => console.warn('arena lighting failed, keeping the studio light', e));
  composer = null;
  if (q === 'high') {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.32, 0.55, 0.88);
    composer.addPass(bloom);
    composer.addPass(makeGradePass(renderer));
  }
  replay.renderer = renderer;
  resize();
}

// the arena's own light: the 360 photo lights and reflects in everything, and
// shows through above the lower bowl
let look = null;
function applyLook() {
  if (!look) return;
  scene.environment = look.env;
  scene.background = look.background;
  scene.backgroundIntensity = 0.55;
  scene.backgroundBlurriness = 0.035;
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  if (composer) composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resolution.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  if (net) net.mat.resolution.copy(resolution);
}
window.addEventListener('resize', () => renderer && resize());

// ---------- match objects ----------
let arena = null, players = [], ball = null, net = null, game = null;
const sound = new Sound();
let input = null;
const replay = new Replay({ camera, sound, canvas });

async function buildMatch(home, away) {
  // the players are most of the download: start them first, in parallel with the arena
  for (const t of [home, away]) if (t.model && settings.models !== false) loadModel(modelUrl(t)).catch(() => {});
  loadMotion(MOTION_URL).catch(() => {});
  // clear previous
  if (arena) scene.remove(arena.group);
  for (const p of players) scene.remove(p.group);
  if (ball) { scene.remove(ball.mesh); scene.remove(ball.blob); }
  if (net) scene.remove(net.lines);
  arena = await buildArena(scene, renderer, { home, away, quality: qualityTier() });
  applyLook();
  // the away side switches to white only when kits clash and it has no photoreal model
  const awayWhite = colorClash(home.jersey, away.jersey) && !(away.model && settings.models !== false);
  players = [new Player(home), new Player(away, { away: awayWhite })];
  for (const p of players) scene.add(p.group);
  // photoreal bodies where a model exists (falls back to the built-in body)
  // Low quality keeps the lighter (31k-triangle) bodies for older phones
  await Promise.all(players.map((p) => (p.team.model && !p.away && settings.models !== false
    ? p.attachSkin(modelUrl(p.team)).catch((e) => console.warn('model failed, using built-in body', e)) : null)));
  ball = new Ball(scene);
  net = new Net(scene, resolution);
  resize();
}

function colorClash(a, b) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  const la = ca.r * 0.3 + ca.g * 0.59 + ca.b * 0.11, lb = cb.r * 0.3 + cb.g * 0.59 + cb.b * 0.11;
  const d = Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b);
  return d < 0.55 || (la < 0.12 && lb < 0.12);
}

// ---------- camera ----------
const cam = { pos: new THREE.Vector3(0, 4.6, 17), look: new THREE.Vector3(0, 1.6, 5), shake: 0, mode: 'play', t: 0 };
function updateCamera(dt, focus, snap = false) {
  const portrait = camera.aspect < 1;
  const hFov = portrait ? 80 : 62;
  const vFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(hFov / 2)) / camera.aspect));
  camera.fov = Math.min(portrait ? 62 : 46, Math.max(30, vFov));
  camera.updateProjectionMatrix();
  // frame both players and the ball, broadcast-style from behind the play
  let fx = focus.x, fz = focus.z, zmax = focus.z;
  if (game) {
    const [a, b] = game.players;
    const bw = game.ball.free ? 0.8 : 0.3;
    fx = (a.pos.x + b.pos.x + game.ball.pos.x * bw * 2) / (2 + bw * 2);
    fz = (a.pos.z + b.pos.z + game.ball.pos.z * bw * 2) / (2 + bw * 2);
    zmax = Math.max(a.pos.z, b.pos.z);
  }
  fz = Math.min(fz, 11);
  const back = portrait ? 10.5 : 7.4;
  const cz = Math.max(fz + back, zmax + (portrait ? 6 : 4.3), 10.5);
  const cy = (portrait ? 7.2 : 3.9) + (cz - fz) * 0.1;
  const tgtPos = new THREE.Vector3(fx * 0.55, cy, cz);
  const lookZ = THREE.MathUtils.lerp(fz - 1.3, RIM.z + 1.2, 0.3);
  const tgtLook = new THREE.Vector3(fx * 0.75, portrait ? 0.9 : 1.75, portrait ? lookZ - 0.5 : lookZ);
  const k = snap ? 1 : 1 - Math.exp(-dt * 3.0);
  cam.pos.lerp(tgtPos, k);
  cam.look.lerp(tgtLook, k);
  camera.position.copy(cam.pos);
  if (cam.shake > 0) {
    cam.shake = Math.max(0, cam.shake - dt * 2.5);
    const a = cam.shake * cam.shake * 0.08;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
  }
  camera.lookAt(cam.look);
}

// ---------- menus ----------
const screens = ['scrTitle'];
function show(id) { for (const s of screens) $(s).hidden = s !== id; }

function seg(el, opts, get, set) {
  el.innerHTML = '';
  for (const [val, label] of opts) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = get() === val ? 'on' : '';
    b.addEventListener('click', () => { set(val); save(); seg(el, opts, get, set); });
    el.appendChild(b);
  }
}

function renderSettings() {
  seg($('segQ'), [['auto', 'Auto'], ['high', 'High'], ['med', 'Medium'], ['low', 'Low']], () => settings.quality, (v) => { settings.quality = v; needsRebuild = true; });
  seg($('segSnd'), [[true, 'On'], [false, 'Off']], () => settings.sound, (v) => { settings.sound = v; sound.setEnabled(v); });
  seg($('segVib'), [[true, 'On'], [false, 'Off']], () => settings.vib, (v) => { settings.vib = v; });
}
let needsRebuild = false;

for (const m of ['modHow', 'modSettings']) {
  $(m).addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close') || e.target === $(m)) {
      $(m).hidden = true;
      if (m === 'modSettings' && needsRebuild) { needsRebuild = false; rebuildRenderer(); }
    }
  });
}
// Start: the loading screen covers the title until the arena and players are
// in. The button still shows progress, and a tap before everything is in starts
// the game as soon as it is.
let matchReady = null, isReady = false, startQueued = false;
function setStartLabel(f = 0) {
  const b = $('goPlay');
  if (isReady) { b.textContent = 'Start'; b.classList.remove('loading'); b.style.removeProperty('--p'); return; }
  b.classList.add('loading');
  b.style.setProperty('--p', `${Math.round(f * 100)}%`);
  b.textContent = startQueued ? 'Starting…' : `Loading ${Math.round(f * 100)}%`;
}
onProgress((f) => { if (!isReady) setStartLabel(f); $('loadBar').style.transform = `scaleX(${f})`; });

// the loading screen (spinning ball); it fades out rather than snapping off
const ldBall = $('ldBall');
if (matchMedia('(prefers-reduced-motion: reduce)').matches) ldBall.pause();
function showLoader() {
  const l = $('loading'); l.hidden = false; l.classList.remove('out');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) ldBall.play().catch(() => {});
}
function hideLoader() {
  const l = $('loading');
  if (l.hidden || l.classList.contains('out')) return;
  l.classList.add('out');
  setTimeout(() => { if (l.classList.contains('out')) { l.hidden = true; ldBall.pause(); } }, 480);
}
$('goPlay').onclick = async () => {
  sound.unlock(); sound.setEnabled(settings.sound);
  if (!isReady) {
    if (startQueued) return;                 // already waiting
    startQueued = true; setStartLabel(); await matchReady;
  }
  startQueued = false;
  startMatch();
};
$('pauseBtn').onclick = () => pause(true);
$('resume').onclick = () => pause(false);
$('pHow').onclick = () => { $('modHow').hidden = false; };
$('pSettings').onclick = () => { renderSettings(); $('modSettings').hidden = false; };
$('quit').onclick = () => { pause(false); endToMenu(); };
$('rematch').onclick = () => { $('modEnd').hidden = true; startMatch(); };
$('toMenu').onclick = () => { $('modEnd').hidden = true; endToMenu(); };

let paused = false;
function pause(on) {
  if (!game) return;
  paused = on;
  $('modPause').hidden = !on;
  sound.duck(on);
}
document.addEventListener('visibilitychange', () => { if (document.hidden && game && !game.over) pause(true); });
// phones play in portrait only: held sideways, the page covers the game (index.html) and it pauses
const sideways = matchMedia('(pointer: coarse) and (orientation: landscape) and (max-height: 520px)');
const onTurn = () => { if (sideways.matches && game && !game.over) pause(true); };
if (sideways.addEventListener) sideways.addEventListener('change', onTurn); else sideways.addListener(onTurn);

async function rebuildRenderer() {
  makeRenderer();
  if (game) {
    const snap = game.snapshot();
    await buildMatch(HOME, AWAY);
    game.rebind({ arena, players, ball, net });
    game.restore(snap);
    replay.bind({ players, ball, net, game, renderer });
  }
}

async function startMatch() {
  const t0 = performance.now();
  showLoader();
  show(null);
  const home = HOME, away = AWAY;
  await buildMatch(home, away);
  $('bugLogoL').src = home.logo; $('bugLogoR').src = away.logo;
  $('bugAbbrL').textContent = home.abbr; $('bugAbbrR').textContent = away.abbr;
  $('bugL').style.setProperty('--team', home.primary);
  $('bugR').style.setProperty('--team', away.primary);
  $('gameTo').textContent = `TO ${GAME_TO}`;
  $('hud').hidden = false;
  $('pad').hidden = false;
  hideLoader();
  if (game) game.dispose();
  if (!input) input = new Input();
  input.parkStick();
  game = new Game({
    arena, players, ball, net, sound, input, cam, threeCamera: camera, scene,
    diff: DIFF, to: GAME_TO, vib: () => settings.vib,
    onEnd: showEnd,
  });
  // highlights: your threes and dunks get a slow-motion replay and a shareable clip
  replay.bind({ players, ball, net, game, renderer });
  game.onHighlight = (h) => replay.highlight({ ...h, names: [HOME.abbr, AWAY.abbr] });
  replay.onClip = showClipChip;
  $('clipChip').hidden = true;
  resize();
  updateCamera(0, game.focus(), true);
  timing.match = performance.now() - t0;
}

function endToMenu() {
  replay.skip(); replay.pending = null; endQueued = null;
  $('clipChip').hidden = true;
  if (game) game.dispose();
  game = null;
  $('hud').hidden = true;
  $('pad').hidden = true;
  show('scrTitle');
  resize();
}

function showEnd(res) {
  const you = HOME, opp = AWAY;
  const winner = res.youWon ? you : opp;
  $('endPh').style.backgroundImage = `url("${winner.portrait}")`;
  $('endEyebrow').textContent = res.youWon ? 'Final · Victory' : 'Final · Defeat';
  $('endRes').textContent = res.youWon ? 'You win' : `${opp.player.last} wins`;
  $('endScore').textContent = `${you.abbr} ${res.score[0]} – ${res.score[1]} ${opp.abbr}`;
  const s = res.stats;
  const row = (k, a, b) => `<span>${k}</span><span>${a}</span><span>${b}</span>`;
  $('endStats').innerHTML = `<span class="h"></span><span class="h">${you.abbr}</span><span class="h">${opp.abbr}</span>` +
    row('Field goals', `${s[0].fgm}/${s[0].fga}`, `${s[1].fgm}/${s[1].fga}`) +
    row('Threes', `${s[0].tpm}/${s[0].tpa}`, `${s[1].tpm}/${s[1].tpa}`) +
    row('Dunks', s[0].dunks, s[1].dunks) +
    row('Blocks', s[0].blk, s[1].blk) +
    row('Steals', s[0].stl, s[1].stl) +
    row('Perfect releases', s[0].green, s[1].green);
  $('endShare').hidden = !replay.clip;
  const open = () => { $('modEnd').hidden = false; $('pad').hidden = true; $('clipChip').hidden = true; };
  // a game-winning three or dunk gets its replay before the final card
  if (replay.pending || replay.active) endQueued = open; else setTimeout(open, 1800);
}

// ---------- replays ----------
let endQueued = null, chipT = 0;
function startReplay() {
  $('hud').hidden = true; $('pad').hidden = true; $('clipChip').hidden = true;
  replay.onDone = () => {
    if (!game) return;
    $('hud').hidden = false;
    if (!game.over) $('pad').hidden = false;
    if (input) input.parkStick();
    if (endQueued) { const f = endQueued; endQueued = null; setTimeout(f, 500); }
  };
  replay.start();
}
function showClipChip() {
  if (!game) return;
  $('endShare').hidden = false;
  if (game.over) return;
  $('clipChip').hidden = false;
  clearTimeout(chipT);
  chipT = setTimeout(() => { $('clipChip').hidden = true; }, 12000);
}
$('replayUI').addEventListener('pointerdown', (e) => { e.preventDefault(); replay.skip(); });
$('clipChip').onclick = async () => { $('clipChip').hidden = true; await shareClip(replay.clip); };
$('endShare').onclick = () => shareClip(replay.clip);

// ---------- loop ----------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const real = (now - last) / 1000;
  const dt = Math.min(0.05, real);
  last = now;
  if (window.__hw && window.__hw.manual) return;   // stepped externally (capture/testing)
  const t0 = performance.now();
  tick(dt);
  if (dbg) dbg.sync();               // Bench: wait for the GPU, so its time counts too
  govern(real);
  if (dbg) dbg.frame(real, performance.now() - t0);
}

// Frame-rate governor (Auto quality only): when a phone can't hold 60 fps in
// play (they slow down as they warm up), render fewer pixels, and hand them
// back when there's headroom. The odd slow frame (a crowd roar, a camera cut)
// doesn't count: only a 3 s stretch under 54 fps steps down. Each step down is
// a trial: if the next 6 s aren't at least 2 fps faster, fewer pixels didn't
// help (the GPU isn't what's short), so the sharper picture comes back and
// stays for two minutes. A scale that just failed isn't retried for a minute.
const gov = { t: 0, n: 0, scale: 1, lock: false, clock: 0, failed: 2, failedAt: -1e9, trial: null, holdUntil: 0 };
function govern(real) {
  if (gov.lock || settings.quality !== 'auto' || !game || paused || replay.active || real > 0.5) { gov.t = gov.n = 0; return; }
  gov.clock += real;
  gov.t += real; gov.n++;
  const tr = gov.trial;
  if (tr) {
    if (gov.t < 6) return;
    const fps = gov.n / gov.t;
    gov.t = gov.n = 0; gov.trial = null;
    if (fps < tr.before + 2) { gov.holdUntil = gov.clock + 120; setGovScale(tr.from); }
    return;
  }
  if (gov.t < 3) return;
  const fps = gov.n / gov.t;
  let s = gov.scale;
  if (fps < 54) {
    gov.failed = s; gov.failedAt = gov.clock;
    if (gov.clock >= gov.holdUntil && s > 0.7) {
      gov.trial = { from: s, before: fps };
      s = Math.max(0.7, Math.round(s * 100 - 5) / 100);
    }
  } else if (gov.t < 6) return;          // watch a while longer before handing pixels back
  else if (fps >= 57.5 && s < 1 && (s + 0.05 < gov.failed - 1e-3 || gov.clock - gov.failedAt > 60)) s = Math.min(1, Math.round(s * 100 + 5) / 100);
  gov.t = gov.n = 0;
  if (s !== gov.scale) setGovScale(s);
}
function setGovScale(s) {
  gov.scale = s;
  renderer.setPixelRatio(basePixelRatio() * s);
  resize();
}

function tick(dt) {
  if (arena) arena.update(dt, camera);
  if (replay.active) {
    // the play again, in slow motion (the crowd stays live)
    if (paused || !game) replay.skip(); else replay.update(dt);
    if (composer) composer.render(); else renderer.render(scene, camera);
    replay.capture();
    if (!replay.active && game) updateCamera(0, game.focus(), true);
    return;
  }
  if (game && !paused) {
    const sdt = dt * game.timeScale;
    game.update(sdt, dt);
    replay.record();
    if (replay.tickPending(dt)) startReplay();
    updateCamera(dt, game.focus());
    const ov = window.__hw && window.__hw.camOverride;
    if (ov) { camera.position.set(...ov.pos); camera.lookAt(...ov.look); }
  } else if (!game) {
    // menu backdrop: slow orbit around the hoop
    cam.t += dt * 0.06;
    camera.position.set(Math.sin(cam.t) * 9, 4.2, 6 + Math.cos(cam.t) * 9);
    camera.lookAt(0, 2.2, 2.5);
  }
  if (composer) composer.render(); else renderer.render(scene, camera);
}

// ---------- boot ----------
const timing = { ready: 0, match: 0 };   // ms: page open to playable, and the last Start tap to play
async function boot() {
  const mode = location.hash.replace('#', '');
  setStartLabel(0);
  // the title waits under the loading screen; let the spinning ball paint before the 3D setup takes the main thread
  if (mode !== 'play') show('scrTitle');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  makeRenderer();
  sound.setEnabled(settings.sound);
  requestAnimationFrame(frame);
  matchReady = buildMatch(HOME, AWAY);
  await matchReady;
  timing.ready = performance.now();
  sound.preload();          // the sounds wait until the players are in (they'd only compete for bandwidth)
  isReady = true;
  setStartLabel();
  $('loadBar').style.transform = 'scaleX(1)';
  // on a fast (cached) load, keep the ball up long enough to see it turn rather than flash
  const shown = performance.now();
  if (shown < 900) await new Promise((r) => setTimeout(r, 900 - shown));
  if (mode === 'play') await startMatch(); else hideLoader();
  $('goPlay').dataset.ready = '1';
}
boot();

// debug hooks for automated checks
window.__hw = { get game() { return game; }, get renderer() { return renderer; }, get arena() { return arena; }, replay, camera, scene, settings, step: (dt) => tick(dt), manual: false, start: () => startMatch() };

// ?debug: the performance panel for testing on real phones (debug.js)
let dbg = null;
if (/[?&#]debug\b/.test(location.search + location.hash)) {
  import('./debug.js').then((m) => {
    dbg = m.startDebug({
      get renderer() { return renderer; }, get game() { return game; }, get paused() { return paused; }, get arena() { return arena; },
      get replayActive() { return replay.active; }, get scale() { return gov.scale; }, get tier() { return qualityTier(); },
      settings, canvas, timing, ldBall, sound, replay, scene,
      start: () => startMatch(),
      lockScale(on) { gov.lock = on; gov.t = gov.n = 0; gov.trial = null; },
      setScale: setGovScale,
    });
  }).catch((e) => console.warn('debug panel failed', e));
}
