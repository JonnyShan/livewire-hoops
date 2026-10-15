// 1v1 rules, possession flow, shooting model, moves/steals/blocks, HUD.
import * as THREE from 'three';
import { BALL_R, AIR_DRAG } from './ball.js';
import { RIM, COURT, isThree } from './arena.js';
import { Input } from './input.js';
import { AI } from './ai.js';

const HUMAN = 0, CPU = 1;
const G = 9.81;
const SHOT_CLOCK = 12;
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// shot timing (seconds from press)
const GATHER = 0.2, AIR = 0.62, T_FULL = 0.74;
const M_APEX = (GATHER + AIR * 0.5) / T_FULL;

function newStats() { return { fga: 0, fgm: 0, tpa: 0, tpm: 0, dunks: 0, blk: 0, stl: 0, green: 0 }; }

export class Game {
  constructor(ctx) {
    Object.assign(this, ctx);   // arena, players, ball, net, sound, camera(cam rig), diff, to, vib, onEnd
    this.timeScale = 1;
    this.slowT = 0;
    this.score = [0, 0];
    this.stats = [newStats(), newStats()];
    this.input = ctx.input || new Input();
    this.ai = new AI(this, CPU, this.diff);
    this.ps = this.players.map((p, i) => ({
      i, p, r: p.info.r,
      intent: { x: 0, z: 0, mag: 0, sprint: false },
      off: 0,            // off-balance timer
      moveCd: 0,         // dribble move cooldown
      burst: null,       // { vx, vz, t }
      squeakCd: 0,
      lastDir: 0,
      hist: [],          // recent positions (for defender lag)
    }));
    this.state = 'check';
    this.t = 0;
    this.stateT = 0;
    this.handler = -1;
    this.poss = Math.random() < 0.6 ? HUMAN : CPU;
    this.needClear = false;
    this.shotClock = SHOT_CLOCK;
    this.shot = null;
    this.lastTouch = -1;
    this.over = false;
    this.events = [];
    this.meterEl = $('meter');
    this.meterFill = $('meterFill');
    this.meterWin = $('meterWin');
    this.tagEl = $('tag');
    this.calloutEl = $('callout');
    this.statusEl = $('status');
    this.firstPoss = true;
    // user indicator ring under your player
    const ringMat = new THREE.MeshBasicMaterial({ color: this.players[HUMAN].team.primary, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 2;
    this.scene.add(this.ring);
    this.beginPossession(this.poss);
  }

  // ---------- helpers ----------
  other(i) { return 1 - i; }
  distToRim(p) { return Math.hypot(p.pos.x - RIM.x, p.pos.z - RIM.z); }
  focus() {
    const f = _v3;
    if (this.handler >= 0) f.copy(this.players[this.handler].pos);
    else f.set(this.ball.pos.x, 0, this.ball.pos.z);
    return f;
  }
  vibrate(ms) { if (this.vib() && navigator.vibrate) try { navigator.vibrate(ms); } catch (e) { /* ignore */ } }
  pan(x) { return clamp(x / 7, -0.8, 0.8); }

  callout(text, sub = '') {
    const el = this.calloutEl;
    el.innerHTML = text + (sub ? `<small>${sub}</small>` : '');
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  tag(text, color, worldPos) {
    const el = this.tagEl;
    el.textContent = text;
    el.style.background = color;
    el.style.color = color === '#3ce07a' || color === '#ffd23f' ? '#081208' : '#fff';
    const s = this.project(worldPos);
    el.style.left = s.x + 'px';
    el.style.top = s.y + 'px';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  project(v) {
    const cam = this.threeCamera;
    _v2.copy(v).project(cam);
    return { x: (_v2.x * 0.5 + 0.5) * window.innerWidth, y: (-_v2.y * 0.5 + 0.5) * window.innerHeight };
  }

  slowmo(scale, dur) { this.timeScale = scale; this.slowT = dur; }

  // ---------- possession flow ----------
  beginPossession(off) {
    const def = this.other(off);
    this.poss = off;
    this.state = 'check';
    this.stateT = 0;
    this.handler = -1;
    this.needClear = false;
    this.shot = null;
    this.shotClock = SHOT_CLOCK;
    this.ball.free = false;
    this.ball.vel.set(0, 0, 0);
    const po = this.players[off], pd = this.players[def];
    po.pos.set(rnd(-0.6, 0.6), 0, 8.7);
    pd.pos.set(po.pos.x * 0.5, 0, 7.35);
    for (const p of this.players) { p.vel.set(0, 0, 0); p.action = null; p.dribble.active = false; p.dribble.crossing = false; }
    po.yaw = Math.PI; // facing the rim (-z)
    pd.yaw = 0;
    po.stance = 'offense';
    pd.stance = 'defense';
    pd.setAction('check');
    for (const s of this.ps) { s.off = 0; s.burst = null; s.hist.length = 0; }
    const team = po.team;
    if (this.firstPoss) { this.callout('Check ball', `${team.abbr} ball first`); this.firstPoss = false; }
    this.updateScorebug();
  }

  giveBall(i, { live = true } = {}) {
    this.handler = i;
    this.poss = i;
    this.ball.free = false;
    this.lastTouch = i;
    const p = this.players[i];
    p.stance = 'offense';
    p.dribble.active = true;
    p.dribble.phase = 0.9;
    p.dribble.hand = -1;
    p.dribble.crossing = false;
    this.players[this.other(i)].stance = 'defense';
    if (live) { this.state = 'live'; this.stateT = 0; }
    this.updateScorebug();
  }

  turnover(toIdx, why) {
    this.sound.buzzer();
    this.callout(why, `${this.players[toIdx].team.abbr} ball`);
    this.state = 'dead';
    this.stateT = 0;
    this.pendingPoss = toIdx;
    this.handler = -1;
    this.ball.free = true;
  }

  // ---------- shooting ----------
  shotBase(d) {
    const tbl = [[0, 0.72], [1.5, 0.62], [3, 0.52], [5, 0.46], [7.24, 0.40], [8.5, 0.30], [10, 0.16], [13, 0.04], [30, 0.0]];
    for (let k = 1; k < tbl.length; k++) {
      if (d <= tbl[k][0]) {
        const [d0, p0] = tbl[k - 1], [d1, p1] = tbl[k];
        return lerp(p0, p1, (d - d0) / (d1 - d0));
      }
    }
    return 0;
  }

  // contest amount 0..1 by defender j on shooter i
  contestOf(i) {
    const sp = this.players[i], dp = this.players[this.other(i)];
    const dx = dp.pos.x - sp.pos.x, dz = dp.pos.z - sp.pos.z;
    const d = Math.hypot(dx, dz);
    const tx = RIM.x - sp.pos.x, tz = RIM.z - sp.pos.z;
    const tl = Math.hypot(tx, tz) || 1;
    const front = (dx * tx + dz * tz) / (d * tl || 1); // 1 = directly between shooter and rim
    const facing = clamp(0.35 + 0.65 * (front + 1) / 2, 0, 1);
    const jumping = dp.action && dp.action.type === 'contest' ? 1 : 0.55;
    const stumbling = this.ps[dp === this.players[0] ? 0 : 1].off > 0 ? 0.3 : 1;
    return clamp((2.1 - d) / 1.35, 0, 1) * jumping * facing * stumbling;
  }

  jumperProb(i, timing, estimate = false) {
    const p = this.players[i], r = this.ps[i].r;
    const d = this.distToRim(p);
    const three = isThree(p.pos.x, p.pos.z);
    const rating = d < 2.5 ? r.finish : three ? r.three : r.mid;
    let pr = this.shotBase(d) * (0.55 + 0.6 * rating / 100);
    if (timing === 'perfect') pr = 0.55 + 0.45 * pr;
    else if (timing === 'bad') pr *= 0.42;
    else if (timing === 'late') pr *= 0.2;
    const c = estimate ? clamp((2.1 - Math.hypot(this.players[1 - i].pos.x - p.pos.x, this.players[1 - i].pos.z - p.pos.z)) / 1.35, 0, 1) * 0.8 : this.contestOf(i);
    pr *= 1 - 0.62 * c;
    const spd = Math.hypot(p.vel.x, p.vel.z);
    pr *= 1 - clamp(spd / 8, 0, 0.3);
    if (i === CPU) pr *= this.diff.shot;
    return clamp(pr, 0.02, 0.97);
  }

  startJumper(i) {
    const p = this.players[i];
    const r = this.ps[i].r;
    const d = this.distToRim(p);
    const three = isThree(p.pos.x, p.pos.z);
    const rating = three ? r.three : r.mid;
    const win = 0.07 + 0.09 * clamp((rating - 40) / 60, 0, 1);
    const jump = (0.28 + 0.22 * (r.dunk / 100)) * (d > 6 ? 0.85 : 1);
    p.dribble.active = false;
    p.setAction('shoot', { jump, air: AIR, win, released: false, three });
    this.shot = { shooter: i, phase: 'rising', win, three, t: 0 };
    this.state = 'shooting';
    this.stateT = 0;
    p.vel.multiplyScalar(0.3);
    this.sound.whoosh();
    if (three) { this.sound.threeUp(i === HUMAN); this.arena.rise(i === HUMAN); }   // the building gets loud for threes
  }

  // ball "set point" while rising for a jumper
  holdBallForShot(p, act, out) {
    const s = p.s;
    const t = act.t;
    const rise = clamp((t - 0.05) / (GATHER + AIR * 0.45), 0, 1);
    const e = rise * rise * (3 - 2 * rise);
    const y = lerp(1.15 * s, 2.12 * s, e) + p.jumpY;
    const fwd = lerp(0.32 * s, 0.14 * s, e);
    return p.localToWorld(out, -0.06 * s, y, fwd).setY(y);
  }

  releaseJumper(i, forcedLate = false) {
    const p = this.players[i];
    const act = p.action;
    if (!act || act.released) return;
    act.released = true;
    const m = act.t / T_FULL;
    const dm = m - M_APEX;
    let timing;
    if (forcedLate) timing = 'late';
    else if (Math.abs(dm) <= act.win / 2) timing = 'perfect';
    else if (Math.abs(dm) <= act.win / 2 + 0.09) timing = 'good';
    else timing = 'bad';
    const label = timing === 'perfect' ? 'PERFECT' : timing === 'good' ? (dm < 0 ? 'SLIGHTLY EARLY' : 'SLIGHTLY LATE') : dm < 0 ? 'EARLY' : 'LATE';
    const col = timing === 'perfect' ? '#3ce07a' : timing === 'good' ? '#ffd23f' : '#ff3b2f';
    const head = p.headWorld(new THREE.Vector3()).add(new THREE.Vector3(0, 0.45, 0));
    if (i === HUMAN) this.tag(label, col, head);
    if (timing === 'perfect') { this.stats[i].green++; if (i === HUMAN) this.vibrate(18); }
    const d = this.distToRim(p);
    const pr = this.jumperProb(i, timing);
    // block check
    const dp = this.players[1 - i];
    if (dp.action && dp.action.type === 'contest') {
      const hand = dp.handWorld(1, new THREE.Vector3());
      const hand2 = dp.handWorld(0, new THREE.Vector3());
      const bpos = this.ball.pos;
      const near = Math.min(hand.distanceTo(bpos), hand2.distanceTo(bpos));
      if (near < 0.5 && Math.random() < 0.25 + 0.45 * (this.ps[1 - i].r.block / 100)) {
        this.blocked(i, 1 - i);
        return;
      }
    }
    const make = Math.random() < pr;
    this.launch(i, make, { d, three: act.three, timing, arc: 1.0 + 0.09 * d, bad: timing === 'bad' || timing === 'late' });
  }

  launch(i, make, { d, three, arc, bad = false, soft = false, type = 'jumper' }) {
    const ball = this.ball;
    const p = this.players[i];
    // aim point
    const dirx = RIM.x - ball.pos.x, dirz = RIM.z - ball.pos.z;
    const dl = Math.hypot(dirx, dirz) || 1;
    const fx = dirx / dl, fz = dirz / dl;
    let ox = 0, oz = 0;
    if (make) {
      const r = Math.random() * (soft ? 0.05 : 0.045), a = Math.random() * Math.PI * 2;
      ox = Math.cos(a) * r; oz = Math.sin(a) * r;
    } else {
      let r = rnd(0.17, 0.3);
      if (bad && Math.random() < 0.3) r = rnd(0.34, 0.55);
      if (Math.random() < 0.65) {
        const s = Math.random() < 0.5 ? -1 : 1;  // short / long
        const jit = rnd(-0.35, 0.35);
        const ax = fx * Math.cos(jit) - fz * Math.sin(jit), az = fx * Math.sin(jit) + fz * Math.cos(jit);
        ox = ax * r * s; oz = az * r * s;
      } else {
        const s = Math.random() < 0.5 ? -1 : 1;
        ox = -fz * r * s; oz = fx * r * s;
      }
    }
    const T = _v.set(RIM.x + ox, RIM.y + 0.02, RIM.z + oz);
    const P0 = ball.pos;
    const H = Math.min(6.2, Math.max(P0.y, T.y) + arc);
    const vy0 = Math.sqrt(2 * G * Math.max(0.05, H - P0.y));
    const tUp = vy0 / G;
    const tDown = Math.sqrt(2 * Math.max(0.02, H - T.y) / G);
    const tt = tUp + tDown;
    // aim through the air drag over that flight time, or every long shot drops short
    const e = (1 - Math.exp(-AIR_DRAG * tt)) / AIR_DRAG;
    ball.vel.set((T.x - P0.x) / e, (T.y - P0.y + G * tt / AIR_DRAG) / e - G / AIR_DRAG, (T.z - P0.z) / e);
    const hx = ball.vel.x, hz = ball.vel.z, hl = Math.hypot(hx, hz) || 1;
    ball.spin.set(-hz / hl, 0, hx / hl).multiplyScalar(18); // backspin: forward x up
    ball.free = true;
    this.handler = -1;
    this.lastTouch = i;
    this.state = 'shot';
    this.stateT = 0;
    const pts = three ? 3 : 2;
    this.shot = { shooter: i, pts, made: false, rim: false, board: false, type, decided: make, t: 0, three };
    const st = this.stats[i];
    st.fga++; if (three) st.tpa++;
  }

  blocked(shooter, blocker) {
    const ball = this.ball;
    const sp = this.players[shooter];
    const ax = sp.pos.x - RIM.x, az = sp.pos.z - RIM.z, al = Math.hypot(ax, az) || 1;
    ball.free = true;
    ball.vel.set((ax / al) * rnd(3.5, 5.5) + rnd(-1.5, 1.5), rnd(1.5, 3), (az / al) * rnd(3.5, 5.5) + rnd(-1.5, 1.5));
    ball.spin.set(rnd(-20, 20), rnd(-10, 10), rnd(-20, 20));
    this.handler = -1;
    this.lastTouch = blocker;
    this.state = 'loose';
    this.stateT = 0;
    this.shot = null;
    this.stats[shooter].fga++;
    this.stats[blocker].blk++;
    this.sound.dribble(2.5);
    this.sound.cheer(0.9, blocker === HUMAN);
    this.arena.cheer(0.8, blocker === HUMAN);
    this.callout('Blocked', this.players[blocker].info.last);
    this.vibrate(30);
    this.cam.shake = 0.6;
  }

  // drive finishes
  startFinish(i) {
    const p = this.players[i];
    const r = this.ps[i].r;
    const d = this.distToRim(p);
    const tx = (RIM.x - p.pos.x) / (d || 1), tz = (RIM.z - p.pos.z) / (d || 1);
    const spd = p.vel.x * tx + p.vel.z * tz;
    const reach = 2.36 * p.s;
    const dunkJump = RIM.y + 0.12 - reach;
    const canDunk = dunkJump < 0.35 + 0.8 * (r.dunk / 100) && spd > 1.8 && d < 3.0 && d > 0.6;
    const dunk = canDunk && Math.random() < 0.35 + 0.6 * (r.dunk / 100);
    p.dribble.active = false;
    const start = p.pos.clone();
    const endD = dunk ? 0.62 : 0.95;
    const end = new THREE.Vector3(RIM.x - tx * endD, 0, RIM.z - tz * endD);
    if (end.z < 0.5) end.z = 0.5;
    if (dunk) {
      p.setAction('dunk', { gather: 0.2, air: 0.62, jump: Math.max(0.5, dunkJump), start, end, slammed: false, hang: false, hangT: 0, dur: 2.0 });
    } else {
      p.setAction('layup', { gather: 0.22, air: 0.74, jump: 0.55 + 0.25 * (r.dunk / 100), start, end, released: false, dur: 1.3 });
    }
    this.state = 'finishing';
    this.stateT = 0;
    this.shot = { shooter: i, type: dunk ? 'dunk' : 'layup' };
  }

  finishProb(i, dunk) {
    const r = this.ps[i].r;
    const c = this.contestOf(i);
    let pr = dunk ? 0.97 - 0.12 * c : (0.5 + 0.35 * r.finish / 100) * (1 - 0.5 * c);
    if (i === CPU) pr *= Math.min(1.05, this.diff.shot + 0.05);
    return clamp(pr, 0.05, 0.98);
  }

  // ---------- moves & steals ----------
  doMove(i, stickX, stickZ) {
    const s = this.ps[i], p = this.players[i];
    if (s.moveCd > 0 || this.handler !== i || p.action) return;
    s.moveCd = 0.6;
    const d = this.distToRim(p) || 1;
    const tx = (RIM.x - p.pos.x) / d, tz = (RIM.z - p.pos.z) / d;
    const m = Math.hypot(stickX, stickZ);
    const dot = m > 0.2 ? (stickX * tx + stickZ * tz) / m : 0;
    const dp = this.players[1 - i];
    const ddx = dp.pos.x - p.pos.x, ddz = dp.pos.z - p.pos.z;
    const dd = Math.hypot(ddx, ddz);
    const hr = s.r.handle / 100;
    let kind;
    if (m > 0.2 && dot < -0.45) kind = 'stepback';
    else if (m > 0.2 && dot > 0.55 && dd < 1.7) kind = 'spin';
    else kind = 'cross';
    const perpX = -tz, perpZ = tx;
    let side;
    if (m > 0.2 && Math.abs(stickX * perpX + stickZ * perpZ) > 0.2) side = Math.sign(stickX * perpX + stickZ * perpZ);
    else side = (ddx * perpX + ddz * perpZ) > 0 ? -1 : 1; // away from defender
    const burst = 4.2 + 1.8 * hr;
    if (kind === 'stepback') {
      s.burst = { vx: -tx * 4.6, vz: -tz * 4.6, t: 0.28 };
      p.dribble.crossing = true; p.dribble.from = p.dribble.hand; p.dribble.phase = 0;
      this.tagMove(i, 'STEP-BACK');
    } else if (kind === 'spin') {
      s.burst = { vx: perpX * side * burst * 0.8 + tx * 2.5, vz: perpZ * side * burst * 0.8 + tz * 2.5, t: 0.42, spin: side };
      this.tagMove(i, 'SPIN');
    } else {
      s.burst = { vx: perpX * side * burst, vz: perpZ * side * burst, t: 0.3 };
      p.dribble.crossing = true; p.dribble.from = p.dribble.hand; p.dribble.phase = 0;
      this.tagMove(i, side > 0 === (p.dribble.hand > 0) ? 'HESI' : 'CROSSOVER');
    }
    this.sound.squeak(this.pan(p.pos.x));
    // does the defender bite?
    if (dd < 2.0) {
      const ds = this.ps[1 - i];
      let bite = 0.18 + (s.r.handle - ds.r.defense) / 100 * 0.9 + (dd < 1.3 ? 0.15 : 0);
      if (kind === 'stepback') bite *= 0.6;
      if (1 - i === CPU) bite *= 1.25 - this.diff.iq * 0.6; else bite *= 0.55; // human defenders react for themselves
      if (Math.random() < clamp(bite, 0.04, 0.8)) {
        ds.off = 0.55;
        dp.setAction('stumble', { dur: 0.6 });
        if (s.r.handle >= 85 && Math.random() < 0.45) this.callout('Ankles', `${p.info.last} breaks ${dp.info.last}`);
        this.arena.cheer(0.4, i === HUMAN);
        this.sound.cheer(0.4, i === HUMAN);
      }
    }
  }

  tagMove(i, text) {
    if (i !== HUMAN) return;
    const p = this.players[i];
    this.tag(text, 'rgba(10,12,18,.8)', p.headWorld(new THREE.Vector3()).add(new THREE.Vector3(0, 0.4, 0)));
  }

  // jab step: sells a drive; a jumpy defender may lean the wrong way
  jab(i, side) {
    const p = this.players[i];
    if (p.action || this.handler !== i) return;
    p.setAction('jab', { side, dur: 0.55 });
    const dp = this.players[1 - i], ds = this.ps[1 - i];
    const d = Math.hypot(dp.pos.x - p.pos.x, dp.pos.z - p.pos.z);
    if (d < 1.8 && 1 - i === CPU && Math.random() < 0.3 * (1.2 - this.diff.iq)) {
      ds.off = 0.3;
      this.tagMove(i, 'JAB');
    }
  }

  trySteal(i) {
    const s = this.ps[i], p = this.players[i];
    if (p.action || s.off > 0) return;
    p.setAction('steal', { dur: 0.45, checked: false });
    p.vel.multiplyScalar(0.5);
  }

  resolveSteal(i) {
    const s = this.ps[i], p = this.players[i];
    const h = this.handler;
    if (h !== 1 - i) return;
    const hp = this.players[h];
    const b = this.ball.pos;
    const dist = Math.hypot(b.x - p.pos.x, b.z - p.pos.z);
    const hs = this.ps[h];
    if (dist > 1.25 || (hp.action && hp.action.type !== 'check')) { this.reach(i); return; }
    let pr = 0.1 + 0.5 * (s.r.steal / 100) - 0.33 * (hs.r.handle / 100);
    if (b.y < 0.55) pr += 0.12;          // ball low and exposed
    if (hp.dribble.crossing) pr += 0.1;  // crossing in front
    if (i === CPU) pr *= this.diff.steal; else pr *= 1.1;
    if (Math.random() < clamp(pr, 0.04, 0.6)) {
      const ball = this.ball;
      ball.free = true;
      const ax = b.x - hp.pos.x, az = b.z - hp.pos.z, al = Math.hypot(ax, az) || 1;
      ball.vel.set(ax / al * rnd(2, 3.5) + rnd(-1, 1), rnd(1.2, 2.4), az / al * rnd(2, 3.5) + rnd(-1, 1));
      this.handler = -1;
      hp.dribble.active = false;
      this.lastTouch = i;
      this.state = 'loose';
      this.stateT = 0;
      this.stealBy = i;
      this.sound.dribble(1.5, this.pan(b.x));
      this.callout('Stolen', p.info.last);
      this.arena.cheer(0.6, i === HUMAN);
      this.sound.cheer(0.5, i === HUMAN);
      this.vibrate(25);
    } else this.reach(i);
  }

  reach(i) {
    this.ps[i].off = 0.5;
    this.players[i].setAction('stumble', { dur: 0.5 });
  }

  contest(i) {
    const p = this.players[i], r = this.ps[i].r;
    if (p.action && p.action.type !== 'check') return;
    p.setAction('contest', { jump: 0.42 + 0.35 * (r.block / 100) * 1.0, air: 0.62, dur: 0.85 });
    p.vel.multiplyScalar(0.4);
  }

  // ---------- main update ----------
  update(dt, realDt) {
    this.t += dt;
    this.stateT += dt;
    if (this.slowT > 0) { this.slowT -= realDt; if (this.slowT <= 0) this.timeScale = 1; }
    const inp = this.input.poll(realDt);
    if (this.autoplay) {
      // soak-test mode: a second CPU brain drives the user's player
      if (!this.ai0) this.ai0 = new AI(this, HUMAN, this.diff);
      if (!this.over) this.ai0.update(dt);
    } else this.humanInput(inp, dt);
    if (!this.over) this.ai.update(dt);
    this.updatePlayers(dt);
    this.updateBall(dt);
    this.updateRules(dt);
    this.net.update(dt, this.ball);
    const me = this.players[HUMAN];
    this.ring.position.set(me.pos.x, 0.006, me.pos.z);
    this.ring.material.opacity = this.over ? 0 : 0.55 + 0.2 * Math.sin(this.t * 4);
    this.sound.update(dt);
    this.updateHud(dt);
    this.input.endFrame();
  }

  humanInput(inp, dt) {
    const i = HUMAN, p = this.players[i], s = this.ps[i];
    // camera-relative stick -> world
    const cam = this.threeCamera;
    cam.getWorldDirection(_v);
    const fx = _v.x, fz = _v.z, fl = Math.hypot(fx, fz) || 1;
    const fwx = fx / fl, fwz = fz / fl;
    const rtx = -fwz, rtz = fwx;
    const wx = rtx * inp.x - fwx * inp.y;
    const wz = rtz * inp.x - fwz * inp.y;
    s.intent.x = wx; s.intent.z = wz; s.intent.mag = inp.mag; s.intent.sprint = inp.sprint;
    const A = this.input.btn.a, B = this.input.btn.b;
    if (this.over) { this.input.setLabels('', '', true, true); return; }

    const offense = this.handler === i;
    const loose = this.state === 'loose' || (this.state === 'shot' && this.ball.free);
    if (offense) this.input.setLabels(this.needClear ? 'CLEAR' : 'SHOOT', 'MOVE', false, this.needClear);
    else if (loose) this.input.setLabels('JUMP', 'STEAL', true);
    else this.input.setLabels('BLOCK', 'STEAL');

    if (offense && this.state === 'live') {
      if (A.pressed) {
        if (this.needClear) { this.flashStatus(); }
        else {
          const d = this.distToRim(p);
          const tx = (RIM.x - p.pos.x) / (d || 1), tz = (RIM.z - p.pos.z) / (d || 1);
          const toward = p.vel.x * tx + p.vel.z * tz;
          if (d < 1.7 || (d < 3.1 && toward > 1.2)) this.startFinish(i);
          else this.startJumper(i);
        }
      }
      if (B.pressed) this.doMove(i, wx, wz);
    } else if (this.state === 'shooting' && this.shot && this.shot.shooter === i) {
      if (A.released || !A.down) this.releaseJumper(i);
    } else if (!offense) {
      if (A.pressed) this.contest(i);
      if (B.pressed && this.handler === 1 - i) this.trySteal(i);
    }
  }

  flashStatus() {
    this.statusEl.textContent = 'CLEAR THE BALL PAST THE ARC';
    this.statusEl.classList.add('on');
    this.statusFlash = 1.2;
  }

  updatePlayers(dt) {
    const ball = this.ball;
    for (let i = 0; i < 2; i++) {
      const p = this.players[i], s = this.ps[i];
      s.moveCd = Math.max(0, s.moveCd - dt);
      s.off = Math.max(0, s.off - dt);
      s.squeakCd = Math.max(0, s.squeakCd - dt);
      const act = p.action;
      const locked = act && ['shoot', 'layup', 'dunk', 'contest', 'check'].includes(act.type);
      // desired velocity
      const hasBall = this.handler === i;
      const r = s.r;
      let max = (s.intent.sprint ? 6.2 : 4.4) * (0.78 + 0.3 * r.speed / 100);
      if (hasBall) max *= 0.92;
      if (p.stance === 'defense' && !s.intent.sprint) max *= 0.95;
      if (i === CPU) max *= this.diff.speed;
      if (s.off > 0) max *= 0.25;
      if (this.state === 'check' || this.state === 'dead' && this.pendingPoss !== undefined && this.stateT > 1.2) max = 0;
      let tvx = s.intent.x * max, tvz = s.intent.z * max;
      if (locked) { tvx = 0; tvz = 0; }
      if (s.burst) {
        s.burst.t -= dt;
        tvx = s.burst.vx; tvz = s.burst.vz;
        if (s.burst.spin) p.yaw += s.burst.spin * dt * 15;
        if (s.burst.t <= 0) s.burst = null;
      }
      const acc = locked ? 10 : s.burst ? 40 : 17;
      const k = 1 - Math.exp(-acc * dt);
      p.vel.x += (tvx - p.vel.x) * k;
      p.vel.z += (tvz - p.vel.z) * k;
      // scripted drive finishes move the body
      if (act && (act.type === 'layup' || act.type === 'dunk')) {
        const u = clamp(act.t / (act.gather + act.air * 0.5), 0, 1);
        const e = 1 - Math.pow(1 - u, 2);
        const nx = lerp(act.start.x, act.end.x, e), nz = lerp(act.start.z, act.end.z, e);
        p.vel.set((nx - p.pos.x) / Math.max(dt, 1e-4), 0, (nz - p.pos.z) / Math.max(dt, 1e-4));
        p.pos.x = nx; p.pos.z = nz;
      } else {
        p.pos.x += p.vel.x * dt;
        p.pos.z += p.vel.z * dt;
      }
      // squeaks on hard cuts
      const spd = Math.hypot(p.vel.x, p.vel.z);
      const dir = Math.atan2(p.vel.x, p.vel.z);
      if (spd > 3 && s.squeakCd <= 0) {
        let dd = Math.abs(Math.atan2(Math.sin(dir - s.lastDir), Math.cos(dir - s.lastDir)));
        if (dd > 0.9) { this.sound.squeak(this.pan(p.pos.x)); s.squeakCd = 0.35; }
      }
      if (spd > 0.5) s.lastDir = dir;
      // facing
      let ty;
      if (hasBall || (act && (act.type === 'shoot' || act.type === 'layup' || act.type === 'dunk'))) {
        const toRim = Math.atan2(RIM.x - p.pos.x, RIM.z - p.pos.z);
        ty = spd > 3.2 && !act ? dir : toRim;
        if (spd > 1 && spd <= 3.2 && !act) {
          // mostly face the rim, lean into movement
          const d0 = Math.atan2(Math.sin(dir - toRim), Math.cos(dir - toRim));
          ty = toRim + clamp(d0, -1.1, 1.1) * 0.5;
        }
      } else if (this.handler === 1 - i) {
        const h = this.players[1 - i];
        ty = Math.atan2(h.pos.x - p.pos.x, h.pos.z - p.pos.z);
        // beaten off the dribble: open the hips and run with the play
        const run = clamp((spd - 3.4) / 1.2, 0, 1);
        if (run > 0) ty += Math.atan2(Math.sin(dir - ty), Math.cos(dir - ty)) * run * 0.9;
      } else {
        ty = Math.atan2(ball.pos.x - p.pos.x, ball.pos.z - p.pos.z);
      }
      if (!(s.burst && s.burst.spin)) {
        const dy = Math.atan2(Math.sin(ty - p.yaw), Math.cos(ty - p.yaw));
        p.yaw += dy * (1 - Math.exp(-dt * 11));
      }
      // look target
      if (hasBall) p.lookAt.copy(RIM);
      else if (this.handler === 1 - i) p.lookAt.copy(this.players[1 - i].pos).setY(1.3);
      else p.lookAt.copy(ball.pos);
      // bounds
      p.pos.x = clamp(p.pos.x, -7.45, 7.45);
      p.pos.z = clamp(p.pos.z, 0.25, 14.1);
      // keep history (defender reaction lag)
      s.hist.push({ t: this.t, x: p.pos.x, z: p.pos.z });
      while (s.hist.length > 2 && this.t - s.hist[0].t > 0.8) s.hist.shift();
    }
    // body collision
    const a = this.players[0], b = this.players[1];
    const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz), minD = 0.36 * (a.s + b.s);
    if (d < minD && d > 1e-4) {
      const push = (minD - d);
      const nx = dx / d, nz = dz / d;
      const aFix = a.jumpY > 0.05, bFix = b.jumpY > 0.05;
      const wa = aFix ? 0 : bFix ? 1 : 0.5, wb = bFix ? 0 : aFix ? 1 : 0.5;
      a.pos.x -= nx * push * wa; a.pos.z -= nz * push * wa;
      b.pos.x += nx * push * wb; b.pos.z += nz * push * wb;
    }

    // animate + ball attachment + IK
    for (let i = 0; i < 2; i++) {
      const p = this.players[i];
      const hasBall = this.handler === i;
      p.dribble.active = hasBall && (!p.action || p.action.type === 'jab');
      if (p.dribble.active) {
        const spd = Math.hypot(p.vel.x, p.vel.z);
        const rate = p.dribble.crossing ? 2.9 : 1.75 + spd * 0.27;
        const prev = p.dribble.phase;
        p.dribble.phase += dt * rate;
        if (prev < 0.45 && p.dribble.phase >= 0.45) this.sound.dribble(0.8 + spd * 0.1, this.pan(p.pos.x));
        if (p.dribble.phase >= 1) {
          p.dribble.phase -= 1;
          if (p.dribble.crossing) { p.dribble.crossing = false; p.dribble.hand = -p.dribble.from; }
        }
      }
      p.animate(dt);
    }
    for (let i = 0; i < 2; i++) this.attach(i, dt);
    for (const p of this.players) p.applyIK(dt);
  }

  // ball position / hand targets for the player holding it, plus action timelines
  attach(i, dt) {
    const p = this.players[i], ball = this.ball, act = p.action, s = p.s;
    const hasBall = this.handler === i;
    // --- check-ball holder (defender) ---
    if (this.state === 'check' && i === this.other(this.poss) && !ball.free) {
      p.localToWorld(ball.pos, 0, 1.12 * s, 0.34 * s);
      p.ikTarget[0] = p.localToWorld(new THREE.Vector3(), 0.1 * s, 1.1 * s, 0.3 * s);
      p.ikTarget[1] = p.localToWorld(new THREE.Vector3(), -0.1 * s, 1.1 * s, 0.3 * s);
      return;
    }
    if (act && act.type === 'shoot' && this.shot && this.shot.shooter === i && !act.released) {
      this.holdBallForShot(p, act, ball.pos);
      const b = ball.pos;
      p.ikTarget[1] = p.localToWorld(new THREE.Vector3(), -0.06 * s - 0.02, 0, 0.14 * s - 0.1).setY(b.y - 0.1);
      p.ikTarget[1].x = lerp(p.ikTarget[1].x, b.x, 0.5); p.ikTarget[1].z = lerp(p.ikTarget[1].z, b.z, 0.5);
      p.ikTarget[0] = p.localToWorld(new THREE.Vector3(), 0.06 * s, 0, 0.14 * s).setY(b.y);
      p.ikTarget[0].lerp(b, 0.35).add(_v.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(0.11));
      // auto release if held too long
      if (act.t > GATHER + AIR * 0.92) this.releaseJumper(i, true);
      if (i === CPU && act.aiRelease !== undefined && act.t >= act.aiRelease) this.releaseJumper(i);
      return;
    }
    if (act && act.type === 'shoot' && act.released) {
      // follow-through
      const up = p.localToWorld(new THREE.Vector3(), -0.08 * s, 2.3 * s + p.jumpY, 0.5 * s);
      up.y = 2.3 * s + p.jumpY;
      if (act.t < GATHER + AIR + 0.25) p.ikTarget[1] = up;
      if (act.t > GATHER + AIR + 0.2) { p.action = null; }
      return;
    }
    if (act && act.type === 'layup') {
      const rel = act.gather + act.air * 0.45;
      if (!act.released) {
        const e = clamp(act.t / rel, 0, 1);
        const y = lerp(1.1 * s, 2.35 * s, e * e) + p.jumpY;
        p.localToWorld(ball.pos, -0.12 * s, 0, lerp(0.3, 0.25, e) * s).setY(y);
        p.ikTarget[1] = ball.pos.clone().add(_v.set(0, -0.1, 0));
        if (e < 0.6) p.ikTarget[0] = ball.pos.clone().add(_v.set(Math.cos(p.yaw) * 0.12, 0, -Math.sin(p.yaw) * 0.12));
        if (act.t >= rel) {
          act.released = true;
          const blockedBy = this.checkFinishBlock(i, false);
          if (blockedBy >= 0) { this.blocked(i, blockedBy); return; }
          const make = Math.random() < this.finishProb(i, false);
          this.launch(i, make, { d: this.distToRim(p), three: false, arc: 0.55, soft: true, type: 'layup' });
        }
      } else {
        p.ikTarget[1] = p.localToWorld(new THREE.Vector3(), -0.1 * s, 0, 0.35 * s).setY(2.5 * s + p.jumpY);
      }
      return;
    }
    if (act && act.type === 'dunk') {
      const slamT = act.gather + act.air * 0.5;
      if (!act.slammed) {
        const e = clamp(act.t / slamT, 0, 1);
        if (e < 0.55) {
          const y = lerp(1.1 * s, 1.6 * s, e / 0.55) + p.jumpY;
          p.localToWorld(ball.pos, 0, 0, 0.3 * s).setY(y);
          p.ikTarget[0] = ball.pos.clone().add(_v.set(Math.cos(p.yaw) * 0.12, 0, -Math.sin(p.yaw) * 0.12));
          p.ikTarget[1] = ball.pos.clone().add(_v.set(-Math.cos(p.yaw) * 0.12, 0, Math.sin(p.yaw) * 0.12));
        } else {
          // cock back over the head then hammer to the rim
          const k = (e - 0.55) / 0.45;
          const back = p.localToWorld(new THREE.Vector3(), -0.05 * s, 0, -0.1 * s).setY(2.45 * s + p.jumpY);
          const rimTop = _v.set(RIM.x, RIM.y + 0.25, RIM.z).lerp(p.pos, 0.18);
          ball.pos.lerpVectors(back, rimTop, k * k);
          p.ikTarget[1] = ball.pos.clone().add(_v2.set(0, 0.08, 0));
        }
        if (act.t >= slamT) {
          act.slammed = true;
          const blockedBy = this.checkFinishBlock(i, true);
          if (blockedBy >= 0) { this.blocked(i, blockedBy); act.hang = false; return; }
          const make = Math.random() < this.finishProb(i, true);
          ball.free = true;
          this.handler = -1;
          this.lastTouch = i;
          this.state = 'shot';
          this.stateT = 0;
          this.stats[i].fga++;
          this.shot = { shooter: i, pts: 2, made: false, rim: false, type: 'dunk', t: 0, three: false };
          if (make) {
            ball.pos.set(RIM.x + rnd(-0.03, 0.03), RIM.y + 0.16, RIM.z + rnd(-0.03, 0.03));
            ball.vel.set(0, -7, 0);
            act.hang = true; act.hangT = 0;
            act.hangY = RIM.y + 0.02 - 2.36 * s;
            this.slowmo(0.4, 0.75);
            this.cam.shake = 1;
            this.vibrate(45);
            this.sound.dunk(this.pan(RIM.x));
          } else {
            ball.pos.set(RIM.x, RIM.y + 0.2, RIM.z + 0.15);
            ball.vel.set(rnd(-2, 2), rnd(3, 4.5), rnd(1.5, 3));
            this.sound.rim(3, 0);
          }
        }
      } else if (act.hang) {
        act.hangT += dt;
        const dir = _v.set(p.pos.x - RIM.x, 0, p.pos.z - RIM.z).normalize();
        const perp = _v2.set(-dir.z, 0, dir.x);
        p.ikTarget[0] = new THREE.Vector3(RIM.x + dir.x * 0.2 + perp.x * 0.12, RIM.y + 0.02, RIM.z + dir.z * 0.2 + perp.z * 0.12);
        p.ikTarget[1] = new THREE.Vector3(RIM.x + dir.x * 0.2 - perp.x * 0.12, RIM.y + 0.02, RIM.z + dir.z * 0.2 - perp.z * 0.12);
        if (act.hangT > 0.45) { act.hang = false; act.dropT = 0; act.dropFrom = act.hangY; }
      } else if (act.dropT !== undefined) {
        act.dropT += dt;
        act.hangY = Math.max(0, act.dropFrom - 0.5 * G * act.dropT * act.dropT);
        act.hang = act.hangY > 0;
        if (!act.hang) { p.action = null; if (this.shot && this.shot.made) p.setAction('celebrate', { dur: 1.1 }); }
      }
      return;
    }
    if (act && act.type === 'contest') {
      const up = 2.25 * p.s + p.jumpY;
      p.ikTarget[0] = p.localToWorld(new THREE.Vector3(), 0.18 * s, 0, 0.3 * s).setY(up);
      p.ikTarget[1] = p.localToWorld(new THREE.Vector3(), -0.18 * s, 0, 0.3 * s).setY(up);
      return;
    }
    if (act && act.type === 'steal') {
      const e = Math.sin(clamp(act.t / 0.4, 0, 1) * Math.PI);
      const tgt = ball.pos.clone();
      const rest = p.localToWorld(new THREE.Vector3(), -0.25 * s, 0.9 * s, 0.3 * s);
      p.ikTarget[1] = rest.lerp(tgt, e * 0.9);
      if (!act.checked && act.t > 0.15) { act.checked = true; this.resolveSteal(i); }
      return;
    }
    if (hasBall && p.dribble.active) {
      p.dribbleBallPos(ball.pos, BALL_R);
      const hand = ball.pos.clone();
      hand.y = Math.max(ball.pos.y + BALL_R * 0.95, 0.66 * s);
      const idx = p.dribble.crossing ? (p.dribble.phase < 0.45 ? (p.dribble.from > 0 ? 0 : 1) : (p.dribble.from > 0 ? 1 : 0)) : (p.dribble.hand > 0 ? 0 : 1);
      p.ikTarget[idx] = hand;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      ball.spin.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(4 + sp * 2.5); // roll forward
    }
  }

  checkFinishBlock(i, dunk) {
    const j = 1 - i, dp = this.players[j];
    if (!dp.action || dp.action.type !== 'contest') return -1;
    const b = this.ball.pos;
    const h1 = dp.handWorld(0, new THREE.Vector3()), h2 = dp.handWorld(1, new THREE.Vector3());
    const near = Math.min(h1.distanceTo(b), h2.distanceTo(b));
    if (near > 0.6) return -1;
    const pr = (0.3 + 0.5 * this.ps[j].r.block / 100) * (dunk ? 0.55 : 1);
    return Math.random() < pr ? j : -1;
  }

  // ---------- ball ----------
  updateBall(dt) {
    const ball = this.ball;
    if (ball.free) {
      const n = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / n;
      const ev = this.events;
      ev.length = 0;
      for (let k = 0; k < n; k++) {
        ball.step(h, ev);
        // score detection
        if (this.shot && !this.shot.made && this.state === 'shot') {
          if (ball.prev.y >= RIM.y && ball.pos.y < RIM.y && ball.vel.y < 0 &&
              Math.hypot(ball.pos.x - RIM.x, ball.pos.z - RIM.z) < COURT.rimR - 0.012) this.scored();
        }
      }
      for (const e of ev) {
        if (e.type === 'rim') { this.sound.rim(e.v, this.pan(ball.pos.x)); if (this.shot) this.shot.rim = true; this.net.energy = 1; }
        else if (e.type === 'board') { this.sound.board(e.v, this.pan(ball.pos.x)); if (this.shot) this.shot.board = true; }
        else if (e.type === 'floor') {
          this.sound.dribble(Math.min(2, e.v / 3), this.pan(ball.pos.x));
          this.onFloor();
        }
      }
    }
    ball.sync(dt);
  }

  onFloor() {
    const b = this.ball.pos;
    const out = Math.abs(b.x) > COURT.halfW || b.z < 0 || b.z > COURT.halfLen;
    if (out && (this.state === 'loose' || this.state === 'shot' || this.state === 'checkpass')) {
      if (this.state === 'shot' && this.shot && this.shot.made) return;
      const to = this.lastTouch >= 0 ? 1 - this.lastTouch : 1 - this.poss;
      this.turnover(to, 'Out of bounds');
    }
  }

  scored() {
    const sh = this.shot;
    sh.made = true;
    const i = sh.shooter;
    this.score[i] += sh.pts;
    const st = this.stats[i];
    st.fgm++; if (sh.pts === 3) st.tpm++;
    if (sh.type === 'dunk') st.dunks++;
    const clean = !sh.rim && !sh.board;
    this.sound.swish(clean);
    const big = sh.type === 'dunk' ? 1.4 : sh.pts === 3 ? 1.1 : 0.7;
    this.sound.made(i === HUMAN, big);
    this.arena.cheer(big, i === HUMAN);
    const p = this.players[i];
    let title = sh.type === 'dunk' ? 'Slam' : sh.pts === 3 ? 'From deep' : clean ? 'Swish' : 'Bucket';
    if (sh.type === 'layup') title = sh.board ? 'Off the glass' : 'Layup';
    const winning = this.score[i] >= this.to;
    this.callout(winning ? 'Game' : title, `${p.info.last} +${sh.pts}`);
    this.state = 'dead';
    this.stateT = 0;
    this.pendingPoss = 1 - i;
    // your threes and dunks get a replay (before the final card on a game winner)
    if (i === HUMAN && (sh.pts === 3 || sh.type === 'dunk') && this.onHighlight) this.onHighlight({ type: sh.type === 'dunk' ? 'dunk' : 'three', shooter: i, tMake: this.t, winning });
    if (winning) this.finish(i);
    else if (sh.type !== 'dunk' && !p.action) p.setAction('celebrate', { dur: 1.0 });
    this.updateScorebug();
  }

  finish(winner) {
    this.over = true;
    this.state = 'over';
    this.slowmo(0.35, 1.2);
    setTimeout(() => this.sound.buzzer(), 300);
    this.arena.buzzer(true);
    this.arena.cheer(1.5, winner === HUMAN);
    this.sound.cheer(1.5, winner === HUMAN);
    this.onEnd({ youWon: winner === HUMAN, score: this.score.slice(), stats: this.stats });
  }

  // ---------- rules ----------
  updateRules(dt) {
    const ball = this.ball;
    const st = this.state;
    if (st === 'over') {
      const w = this.score[0] > this.score[1] ? 0 : 1;
      const p = this.players[w];
      if (!p.action && Math.random() < 0.02) p.setAction('celebrate', { dur: 1.2 });
      return;
    }
    if (st === 'check') {
      const off = this.poss, def = 1 - off;
      if (this.stateT > 0.75 && !ball.free) {
        // bounce pass from defender to offense
        const po = this.players[off];
        const P0 = ball.pos, tgt = po.localToWorld(new THREE.Vector3(), 0, 1.0 * po.s, 0.3 * po.s);
        const t1 = 0.32;
        const bx = lerp(P0.x, tgt.x, 0.55), bz = lerp(P0.z, tgt.z, 0.55);
        ball.vel.set((bx - P0.x) / t1, (BALL_R - P0.y + 0.5 * G * t1 * t1) / t1, (bz - P0.z) / t1);
        ball.free = true;
        this.players[def].action = null;
        this.state = 'checkpass';
        this.stateT = 0;
        this.lastTouch = def;
      }
      return;
    }
    if (st === 'checkpass') {
      const po = this.players[this.poss];
      const hand = po.localToWorld(new THREE.Vector3(), 0, 1.0 * po.s, 0.3 * po.s);
      if ((ball.pos.distanceTo(hand) < 0.55 && ball.vel.y < 1.5) || this.stateT > 1.6) {
        this.giveBall(this.poss);
        this.shotClock = SHOT_CLOCK;
      }
      return;
    }
    if (st === 'live') {
      this.shotClock -= dt;
      if (this.handler >= 0 && this.needClear) {
        const h = this.players[this.handler];
        if (isThree(h.pos.x, h.pos.z)) { this.needClear = false; this.statusEl.classList.remove('on'); }
      }
      if (this.shotClock <= 0) { this.shotClock = 0; this.turnover(1 - this.poss, 'Shot clock'); }
      return;
    }
    if (st === 'shooting') {
      this.shotClock = Math.max(0, this.shotClock - dt);
      return;
    }
    if (st === 'finishing') return;
    if (st === 'shot') {
      if (this.shot) this.shot.t += dt;
      // once the ball is below the rim and falling (or airball lands), it's a live rebound
      if (!this.shot.made && ((this.shot.rim || this.shot.board) && ball.vel.y < 0 && ball.pos.y < RIM.y - 0.1 || ball.pos.y < 1.2 && this.shot.t > 0.3)) {
        if (!this.shot.rim && !this.shot.board) this.callout('Air ball');
        this.sound.missed(this.shot.shooter === HUMAN);
        this.arena.settle();
        this.state = 'loose';
        this.stateT = 0;
        this.shotClockReset = true;
      }
      if (this.shot && !this.shot.made && this.shot.rim && ball.vel.y < 0 && ball.pos.y < RIM.y + 0.1) this.grabCheck();
      return;
    }
    if (st === 'loose') {
      this.grabCheck();
      if (this.stateT > 8) this.turnover(1 - this.poss, 'Jump ball');
      return;
    }
    if (st === 'dead') {
      if (this.stateT > 1.9 && this.pendingPoss !== undefined) {
        this.arena.buzzer(false);
        const to = this.pendingPoss;
        this.pendingPoss = undefined;
        this.beginPossession(to);
      }
    }
  }

  grabCheck() {
    const ball = this.ball;
    if (ball.pos.y < 0.12 && Math.abs(ball.vel.y) < 0.2 && Math.hypot(ball.vel.x, ball.vel.z) < 0.2) { /* resting, still grabbable */ }
    let best = -1, bestD = 1e9;
    for (let i = 0; i < 2; i++) {
      const p = this.players[i];
      if (this.ps[i].off > 0.3) continue;
      if (this.shot && this.shot.shooter === i && this.state === 'shot' && this.shot.t < 0.4) continue;
      const reach = 2.42 * p.s + p.jumpY;
      const dxz = Math.hypot(ball.pos.x - p.pos.x, ball.pos.z - p.pos.z);
      if (ball.pos.y < reach && dxz < 0.6 + (p.jumpY > 0.1 ? 0.15 : 0)) {
        const score = dxz - p.jumpY * 0.8 - (i === CPU ? 0 : 0.05);
        if (score < bestD) { bestD = score; best = i; }
      }
    }
    if (best < 0) return;
    const shooter = this.shot ? this.shot.shooter : this.poss;
    const offReb = best === shooter && this.shot;
    const stolen = this.stealBy === best;
    this.stealBy = undefined;
    this.shot = null;
    const changed = best !== this.poss;
    this.giveBall(best);
    this.shotClock = SHOT_CLOCK;
    if (changed || stolen) {
      this.needClear = true;
      if (best === HUMAN) this.flashStatus();
    } else this.needClear = false;
    if (offReb) this.callout('Offensive board', this.players[best].info.last);
    this.players[best].action = null;
  }

  // ---------- HUD ----------
  updateScorebug() {
    $('ptsL').textContent = this.score[0];
    $('ptsR').textContent = this.score[1];
    $('hasL').classList.toggle('on', this.poss === 0);
    $('hasR').classList.toggle('on', this.poss === 1);
  }

  updateHud(dt) {
    const sc = Math.ceil(this.shotClock);
    const scEl = $('shotClock');
    const txt = this.state === 'check' || this.state === 'checkpass' ? String(SHOT_CLOCK) : String(Math.max(0, sc));
    if (scEl.textContent !== txt) scEl.textContent = txt;
    this.arena.setShotClock(txt, true);
    // status line
    if (this.statusFlash > 0) {
      this.statusFlash -= dt;
      if (this.statusFlash <= 0 && !(this.needClear && this.handler === HUMAN)) this.statusEl.classList.remove('on');
    } else if (this.needClear && this.handler === HUMAN) {
      this.statusEl.textContent = 'CLEAR THE BALL PAST THE ARC';
      this.statusEl.classList.add('on');
    } else if (!this.over && Math.max(this.score[0], this.score[1]) >= this.to - 2 && this.state === 'live') {
      this.statusEl.textContent = 'GAME POINT';
      this.statusEl.classList.add('on');
    } else this.statusEl.classList.remove('on');
    // shot meter over the human shooter
    const p = this.players[HUMAN];
    const act = p.action;
    if (act && act.type === 'shoot' && this.shot && this.shot.shooter === HUMAN && act.t < GATHER + AIR + 0.2) {
      const s = this.project(p.headWorld(_v).add(_v2.set(0, 0.1, 0)));
      this.meterEl.style.left = (s.x + 34) + 'px';
      this.meterEl.style.top = (s.y - 60) + 'px';
      const m = clamp(act.t / T_FULL, 0, 1);
      this.meterFill.style.height = (m * 100) + '%';
      this.meterWin.style.bottom = ((M_APEX - act.win / 2) * 100) + '%';
      this.meterWin.style.height = (act.win * 100) + '%';
      this.meterEl.classList.add('on');
    } else this.meterEl.classList.remove('on');
  }

  // renderer rebuild support
  snapshot() { return { score: this.score.slice(), stats: this.stats, poss: this.poss }; }
  restore(s) { this.score = s.score; this.stats = s.stats; this.beginPossession(s.poss); }
  rebind(o) { Object.assign(this, o); }
  dispose() { this.scene.remove(this.ring); }
}

export { HUMAN, CPU, GATHER, AIR, T_FULL, M_APEX };
