// Bootstrap: renderer, quality tiers, menus, match setup, main loop.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { TEAMS, DIFFICULTY, ROSTERS } from './data.js';
import { buildArena } from './arena.js';
import { COURT, BASKETS } from './court.js';
import { Player, loadModel } from './player.js';
import { loadMotion, MOTION_URL } from './motion.js';
import { Ball, Net } from './ball.js';
import { Game, TEAM_SIZE } from './game.js';
import { Presenter } from './present.js';
import { Sound } from './audio.js';
import { Input } from './input.js';
import { installGrade, makeGradePass, loadArenaLight } from './look.js';
import { onProgress } from './progress.js';
import { Replay, shareClip } from './replay.js';
import { playMark } from './lwmark.js';

installGrade();

const $ = (id) => document.getElementById(id);

// ---------- settings ----------
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const settings = { quality: 'auto', sound: true, vib: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem('hardwood.settings') || '{}')); } catch (e) { /* storage blocked */ }
const save = () => { try { localStorage.setItem('hardwood.settings', JSON.stringify(settings)); } catch (e) { /* storage blocked */ } };
// the two kits: Livewire yellow (you) and Livewire black (the CPU), three a side
const HOME = TEAMS[0], AWAY = TEAMS[1];
const DIFF = DIFFICULTY.pro, MATE_DIFF = DIFFICULTY.pro;
const qualityTier = () => settings.quality === 'auto' ? (isTouch ? 'med' : 'high') : settings.quality;
// six bodies on a phone: the lighter (31k-triangle) ones below High quality
const lightBodies = () => qualityTier() !== 'high';
// a player's body: his own model if he has one, else his team star's (scaled to his height)
function bodyOf(team, info) {
  const own = info.model ? info : team.player;
  const src = info.model ? info : team;
  const url = lightBodies() && src.modelLo ? src.modelLo : src.model;
  return { url, scale: info.model ? 1 : info.height / own.height };
}
const modelUrls = () => [...new Set([HOME, AWAY].flatMap((t, k) => ROSTERS[k].map((info) => bodyOf(t, info).url)).filter(Boolean))];
// the players are most of the download: start them the moment the page script runs
if (settings.models !== false) for (const u of modelUrls()) loadModel(u).catch(() => {});
loadMotion(MOTION_URL).catch(() => {});

// ---------- renderer ----------
const canvas = $('gl');
let renderer, composer, bloom;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 140);
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
  for (const n of nets) n.mat.resolution.copy(resolution);
}
window.addEventListener('resize', () => renderer && resize());

// ---------- match objects ----------
let arena = null, players = [], ball = null, nets = [], game = null, presenter = null;
const sound = new Sound();
let input = null;
const replay = new Replay({ camera, sound, canvas });

async function buildMatch(home, away) {
  // the players are most of the download: start them first, in parallel with the arena
  if (settings.models !== false) for (const u of modelUrls()) loadModel(u).catch(() => {});
  loadMotion(MOTION_URL).catch(() => {});
  // clear previous
  if (arena) scene.remove(arena.group);
  for (const p of players) scene.remove(p.group);
  if (ball) { scene.remove(ball.mesh); scene.remove(ball.blob); }
  for (const n of nets) scene.remove(n.lines);
  arena = await buildArena(scene, renderer, { home, away, quality: qualityTier() });
  applyLook();
  players = [];
  [home, away].forEach((team, k) => { for (let j = 0; j < TEAM_SIZE; j++) players.push(new Player(team, { info: ROSTERS[k][j] })); });
  for (const p of players) scene.add(p.group);
  // photoreal bodies where a model exists (falls back to the built-in body)
  await Promise.all(players.map((p) => {
    if (!p.team.model || settings.models === false) return null;
    const b = bodyOf(p.team, p.info);
    return p.attachSkin(b.url, { scale: b.scale }).catch((e) => console.warn('model failed, using built-in body', e));
  }));
  ball = new Ball(scene);
  nets = [new Net(scene, resolution, 0), new Net(scene, resolution, 1)];
  resize();
}

function colorClash(a, b) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  const la = ca.r * 0.3 + ca.g * 0.59 + ca.b * 0.11, lb = cb.r * 0.3 + cb.g * 0.59 + cb.b * 0.11;
  const d = Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b);
  return d < 0.55 || (la < 0.12 && lb < 0.12);
}

// ---------- camera ----------
// Portrait, the court running up the screen: the camera rides behind the play
// on the +z side, looking toward basket A (the one you attack), and follows the
// ball along the court. When the CPU attacks basket B the play comes toward you.
const cam = { pos: new THREE.Vector3(0, 9, 24), look: new THREE.Vector3(0, 0.8, 12), shake: 0, mode: 'play', t: 0 };
const _cf = new THREE.Vector3();
function updateCamera(dt, focus, snap = false) {
  const portrait = camera.aspect < 1;
  const hFov = portrait ? 84 : 62;
  const vFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(hFov / 2)) / camera.aspect));
  camera.fov = Math.min(portrait ? 68 : 46, Math.max(30, vFov));
  camera.updateProjectionMatrix();
  // follow the ball, weighted a little toward the players near it
  let fx = focus.x, fz = focus.z;
  if (game) {
    const b = game.ball.pos;
    let sx = 0, sz = 0, sw = 0;
    for (const p of game.players) {
      const w = 1 / (1 + p.pos.distanceTo(b) * 0.5);
      sx += p.pos.x * w; sz += p.pos.z * w; sw += w;
    }
    const bw = game.ball.free ? 2.2 : 1.4;
    fx = (sx + b.x * bw) / (sw + bw);
    fz = (sz + b.z * bw) / (sw + bw);
    // lead the play: look up the floor when you attack, give room toward you when they do
    const t = game.poss;
    if (t === 0) fz -= 1.2; else if (t === 1) fz += 1.6;
  }
  fz = THREE.MathUtils.clamp(fz, 2.5, COURT.len - 2);
  const back = portrait ? 10.5 : 8.5;
  // at basket B's end the camera stops just behind the baseline and rises to look down on the play
  const cz = Math.min(fz + back, COURT.len + 2.4);
  const cy = (portrait ? 9.2 : 5.2) + Math.max(0, fz + back - cz) * 0.55;
  const tgtPos = _cf.set(fx * 0.72, cy, cz);
  const lookZ = fz - (portrait ? 2.8 : 2.2);
  const tgtLook = new THREE.Vector3(fx * 0.85, portrait ? 0.4 : 1.4, lookZ);
  const k = snap ? 1 : 1 - Math.exp(-dt * 2.8);
  cam.pos.lerp(tgtPos, k);
  cam.look.lerp(tgtLook, k);
  camera.position.copy(cam.pos);
  fadeHoopB(cam.pos.z);
  if (cam.shake > 0) {
    cam.shake = Math.max(0, cam.shake - dt * 2.5);
    const a = cam.shake * cam.shake * 0.08;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
  }
  camera.lookAt(cam.look);
}

// Basket B's post, arm and shot clock stand between the camera and the play
// when the CPU attacks toward you: they fade out while the camera is behind it.
let hoopBParts = null, hoopBFade = -1;
function fadeHoopB(camZ) {
  if (!arena || !arena.hoops) return;
  if (!hoopBParts || hoopBParts.arena !== arena) {
    hoopBParts = { arena, mats: [] };
    hoopBFade = -1;
    const glassZ = COURT.len - COURT.boardZ;
    const c = new THREE.Vector3();
    arena.hoops[1].updateMatrixWorld(true);
    arena.hoops[1].traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      o.geometry.boundingBox.getCenter(c).applyMatrix4(o.matrixWorld);
      if (c.z < glassZ + 0.025) return;                       // the glass, its frame, the rim: keep
      const mats = [].concat(o.material).map((mt) => (mt.transparent ? mt : mt.clone()));
      if (mats.some((mt) => mt.transparent && mt.opacity < 0.5)) return;
      o.material = Array.isArray(o.material) ? mats : mats[0];
      hoopBParts.mats.push(...mats);
    });
  }
  const f = THREE.MathUtils.clamp((camZ - (COURT.len - 1.5)) / 2.5, 0, 1);
  if (Math.abs(f - hoopBFade) < 0.01) return;
  hoopBFade = f;
  for (const mt of hoopBParts.mats) {
    const tr = f > 0.01;
    if (mt.transparent !== tr) { mt.transparent = tr; mt.needsUpdate = true; }
    mt.opacity = 1 - 0.82 * f;
    mt.depthWrite = f < 0.5;
  }
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
  seg($('segSnd'), [[true, 'On'], [false, 'Off']], () => settings.sound, (v) => { settings.sound = v; sound.setEnabled(v); showMute(); });
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
  playMark(l, 'build');
}
function hideLoader() {
  const l = $('loading');
  if (l.hidden || l.classList.contains('out')) return;
  l.classList.add('out');
  setTimeout(() => { if (l.classList.contains('out')) { l.hidden = true; ldBall.pause(); } }, 480);
  // the title shows through as the loading screen fades: build the Livewire mark in as it does
  if (!$('scrTitle').hidden) setTimeout(() => playMark($('scrTitle'), 'build'), 200);
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
// mute: the same switch as Sound in Settings
function showMute() {
  const b = $('muteBtn');
  b.classList.toggle('off', !settings.sound);
  b.setAttribute('aria-pressed', String(!settings.sound));
  b.setAttribute('aria-label', settings.sound ? 'Mute' : 'Unmute');
}
$('muteBtn').onclick = () => {
  settings.sound = !settings.sound;
  save();
  sound.unlock();
  sound.setEnabled(settings.sound);
  showMute();
};
showMute();
$('resume').onclick = () => pause(false);
$('pHow').onclick = () => { $('modHow').hidden = false; };
$('pSettings').onclick = () => { renderSettings(); $('modSettings').hidden = false; };
$('quit').onclick = () => { pause(false); endToMenu(); };
$('rematch').onclick = () => { $('modEnd').hidden = true; startMatch(); };
$('toMenu').onclick = () => { $('modEnd').hidden = true; endToMenu(); };

let paused = false;
function pause(on) {
  if (on && (!game || game.over)) return;
  paused = on;
  $('modPause').hidden = !on;
  sound.duck(on);
}
document.addEventListener('visibilitychange', () => { if (document.hidden && game && !game.over) pause(true); });
// P pauses and resumes on a keyboard
window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'p' && !e.repeat && game && !game.over && !replay.active) pause(!paused); });
// phones play in portrait only: held sideways, the page covers the game (index.html) and it pauses
const sideways = matchMedia('(pointer: coarse) and (orientation: landscape) and (max-height: 520px)');
const onTurn = () => { if (sideways.matches && game && !game.over) pause(true); };
if (sideways.addEventListener) sideways.addEventListener('change', onTurn); else sideways.addListener(onTurn);

// a quality change mid-game rebuilds the scene; the game holds still until it's back
let rebuilding = false;
async function rebuildRenderer() {
  makeRenderer();
  if (!game) return;
  const g = game;
  rebuilding = true;
  replay.skip(); replay.pending = null;
  const snap = g.snapshot();
  const old = g.players.map((p) => ({ pos: p.pos.clone(), vel: p.vel.clone(), yaw: p.yaw }));
  try {
    await buildMatch(HOME, AWAY);
    if (game !== g) return;
    // the new bodies stand where the old ones stood
    players.forEach((p, i) => { p.pos.copy(old[i].pos); p.vel.copy(old[i].vel); p.yaw = old[i].yaw; });
    g.rebind({ arena, players, ball, nets });
    if (presenter) presenter.dispose();
    presenter = makePresenter();
    g.restore(snap);
    replay.bind({ players, ball, net: nets[0], game: g, renderer });
  } finally { rebuilding = false; }
}

function makePresenter() {
  return new Presenter({ sound, arena, scene, camera, cam, vib: () => settings.vib, teams: [HOME, AWAY], ball });
}

async function startMatch(opts = {}) {
  const t0 = performance.now();
  pause(false);
  showLoader();
  show(null);
  const home = HOME, away = AWAY;
  await buildMatch(home, away);
  $('bugLogoL').src = home.logo; $('bugLogoR').src = away.logo;
  $('bugAbbrL').textContent = home.abbr; $('bugAbbrR').textContent = away.abbr;
  $('bugL').style.setProperty('--team', home.primary);
  $('bugR').style.setProperty('--team', away.primary);
  $('hud').hidden = false;
  $('pad').hidden = !!opts.autoplay;
  hideLoader();
  if (game) game.dispose();
  if (presenter) presenter.dispose();
  presenter = makePresenter();
  if (!input) input = new Input();
  input.parkStick();
  game = new Game({
    arena, players, ball, nets, input, threeCamera: camera, scene,
    diff: DIFF, mateDiff: MATE_DIFF, autoplay: !!opts.autoplay, seed: opts.seed,
    fx: (type, d, g) => { if (presenter) presenter.handle(type, d, g); },
    onEnd: showEnd,
  });
  // highlights: your threes and dunks get a slow-motion replay and a shareable clip
  replay.bind({ players, ball, net: nets[0], game, renderer });
  game.onHighlight = (h) => replay.highlight({ ...h, names: [HOME.abbr, AWAY.abbr] });
  replay.onClip = showClipChip;
  $('clipChip').hidden = true;
  resize();
  updateCamera(0, game.focus(), true);
  timing.match = performance.now() - t0;
}

function endToMenu() {
  pause(false);
  replay.skip(); replay.pending = null; endQueued = null;
  $('clipChip').hidden = true;
  if (game) game.dispose();
  game = null;
  if (presenter) { presenter.dispose(); presenter = null; }
  $('hud').hidden = true;
  $('pad').hidden = true;
  show('scrTitle');
  playMark($('scrTitle'), 'build');
  resize();
}

function showEnd(res) {
  const you = HOME, opp = AWAY;
  const winner = res.youWon ? you : opp;
  $('endPh').style.backgroundImage = `url("${winner.portrait}")`;
  $('endEyebrow').textContent = (res.youWon ? 'Final · Victory' : 'Final · Defeat') + (res.overtime ? ' · Sudden death' : '');
  $('endRes').textContent = res.youWon ? 'You win' : `${opp.abbr[0] + opp.abbr.slice(1).toLowerCase()} wins`;
  $('endScore').textContent = `${you.abbr} ${res.score[0]} – ${res.score[1]} ${opp.abbr}`;
  const s = res.stats;
  // the game's top scorer
  let mvp = 0;
  res.pstats.forEach((p, i) => { if (p.pts > res.pstats[mvp].pts || (p.pts === res.pstats[mvp].pts && p.ast > res.pstats[mvp].ast)) mvp = i; });
  const row = (k, a, b) => `<span>${k}</span><span>${a}</span><span>${b}</span>`;
  $('endStats').innerHTML = `<span class="h"></span><span class="h">${you.abbr}</span><span class="h">${opp.abbr}</span>` +
    row('Field goals', `${s[0].fgm}/${s[0].fga}`, `${s[1].fgm}/${s[1].fga}`) +
    row('Threes', `${s[0].tpm}/${s[0].tpa}`, `${s[1].tpm}/${s[1].tpa}`) +
    row('Dunks', s[0].dunks, s[1].dunks) +
    row('Assists', s[0].ast, s[1].ast) +
    row('Blocks', s[0].blk, s[1].blk) +
    row('Steals', s[0].stl, s[1].stl) +
    row('Top scorer', mvp < TEAM_SIZE ? `${players[mvp].info.last} ${res.pstats[mvp].pts}` : '', mvp >= TEAM_SIZE ? `${players[mvp].info.last} ${res.pstats[mvp].pts}` : '');
  $('endShare').hidden = !replay.clip;
  const g = game;
  const open = () => { if (game !== g) return; $('modEnd').hidden = false; $('pad').hidden = true; $('clipChip').hidden = true; };
  // a game-winning three or dunk gets its replay before the final card
  if (replay.pending || replay.active) endQueued = open; else setTimeout(open, 1800);
}

// ---------- replays ----------
let endQueued = null, chipT = 0;
function startReplay() {
  $('hud').hidden = true; $('pad').hidden = true; $('clipChip').hidden = true;
  if (presenter) presenter.setHidden(true);
  replay.onDone = () => {
    if (presenter) presenter.setHidden(false);
    if (!game) return;
    $('hud').hidden = false;
    if (!game.over && !game.autoplay) $('pad').hidden = false;
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
  if (game && !paused && !rebuilding) {
    const sdt = dt * game.timeScale;
    game.update(sdt, dt);
    if (presenter) presenter.frame(dt, game);
    replay.record();
    if (replay.tickPending(dt)) startReplay();
    updateCamera(dt, game.focus());
    if (arena && arena.follow) arena.follow(cam.look.x, cam.look.z);
    const ov = window.__hw && window.__hw.camOverride;
    if (ov) { camera.position.set(...ov.pos); camera.lookAt(...ov.look); }
  } else if (!game) {
    // menu backdrop: a slow pass along the court toward basket A
    cam.t += dt * 0.06;
    const c = COURT.halfLen;
    camera.position.set(Math.sin(cam.t) * 6.5, 4.6, c + Math.cos(cam.t) * 3 - 3);
    camera.lookAt(0, 2.4, BASKETS[0].rim.z + 1);
    if (arena && arena.follow) arena.follow(0, c / 2);
    // under the title or loading screen nobody sees it: draw now and then (keeps it warm), not every frame
    if ((!$('scrTitle').hidden || !$('loading').hidden) && (cam.skip = ((cam.skip || 0) + 1) % 20) !== 0) return;
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
  if (mode === 'play' || mode === 'autoplay') await startMatch({ autoplay: mode === 'autoplay' }); else hideLoader();
  $('goPlay').dataset.ready = '1';
}
boot();

// debug hooks for automated checks
window.__hw = { get game() { return game; }, get renderer() { return renderer; }, get arena() { return arena; }, replay, camera, scene, settings, step: (dt) => tick(dt), manual: false, start: (o) => startMatch(o), get presenter() { return presenter; } };

// ?debug: the performance panel for testing on real phones (debug.js)
let dbg = null;
if (/[?&#]debug\b/.test(location.search + location.hash)) {
  import('./debug.js').then((m) => {
    dbg = m.startDebug({
      get renderer() { return renderer; }, get game() { return game; }, get paused() { return paused; }, get arena() { return arena; },
      get replayActive() { return replay.active; }, get scale() { return gov.scale; }, get tier() { return qualityTier(); },
      settings, canvas, timing, ldBall, sound, replay, scene,
      start: (o) => startMatch(o),
      lockScale(on) { gov.lock = on; gov.t = gov.n = 0; gov.trial = null; },
      setScale: setGovScale,
    });
  }).catch((e) => console.warn('debug panel failed', e));
}
