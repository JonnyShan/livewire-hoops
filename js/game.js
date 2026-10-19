// 3v3 full-court rules: tip-off, possession flow, passing, the shooting model,
// moves/steals/blocks, the game and shot clocks, the hot hand.
//
// The game is the simulation only. Every player is driven the same way, through
// its intent (stick) and the commands below (cmdShoot, cmdPass, cmdMove, ...),
// whether the user, the team AI (ai.js) or, later, a player online sends them.
// Everything it wants seen or heard goes out as events through fx(type, data)
// for the presentation (present.js), and its dice come from a seeded generator.
import * as THREE from 'three';
import { BALL_R, AIR_DRAG } from './ball.js';
import { COURT, BASKETS, isThree, toFrame, inBounds } from './court.js';
import { Input } from './input.js';
import { TeamAI } from './ai.js';

export const TEAM_SIZE = 3;
export const GAME_LEN = 120;          // one 2-minute game, live time
export const SHOT_CLOCK = 14;
const G = 9.81;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _f = { x: 0, z: 0 };

// shot timing (seconds from press)
export const GATHER = 0.2, AIR = 0.62, T_FULL = 0.74;
export const M_APEX = (GATHER + AIR * 0.5) / T_FULL;
const CATCH_T = 0.16;                 // the ball settles into the hands over this long
const PASS_WIND = 0.1;                // ball leaves the hands this long after the pass starts
const DUNK_CHARGE = 15;               // seconds of play to fill a team's dunk meter
const DUNK_REACH = 4.2;               // a full meter lets you take off from this far out
const DANCES = ['danceHipHop', 'danceYMCA', 'danceBoom'];   // the winners' victory dances (models/motion.json)

// the clocks run only while the ball is live
const LIVE = new Set(['live', 'shooting', 'finishing', 'shot', 'loose', 'pass']);

function newStats() { return { pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, dunks: 0, blk: 0, stl: 0, ast: 0, green: 0 }; }

// small, fast, seedable generator (mulberry32)
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  constructor(ctx) {
    // arena, players (6: 0-2 team 0, 3-5 team 1), ball, nets [A, B], diff, mateDiff, fx, ...
    Object.assign(this, ctx);
    const fx = ctx.fx;
    this.fx = (type, data) => { if (fx) fx(type, data, this); };
    this.seed = ctx.seed ?? ((Math.random() * 2 ** 32) >>> 0);
    this.rng = makeRng(this.seed);
    this.timeScale = 1;
    this.slowT = 0;
    this.score = [0, 0];
    this.stats = [newStats(), newStats()];
    this.pstats = this.players.map(() => newStats());
    this.input = ctx.input || new Input();
    this.mateDiff = ctx.mateDiff || this.diff;
    this.ps = this.players.map((p, i) => ({
      i, p, r: p.info.r, team: this.teamOf(i),
      intent: { x: 0, z: 0, mag: 0, sprint: false },
      off: 0,            // off-balance timer
      moveCd: 0,         // dribble move cooldown
      burst: null,       // { vx, vz, t }
      squeakCd: 0,
      lastDir: 0,
      hist: [],          // recent positions (for defender lag)
      streak: 0,         // baskets in a row while the other team hasn't scored
      triedPass: null,   // the pass this defender already went for
    }));
    this.user = this.autoplay ? -1 : 0;     // the player you control (team 0)
    this.hot = [-1, -1];                   // the player on fire, per team
    this.dunkMeter = [0, 0];               // 0..1 per team: a full one turns the next drive into a dunk
    this.clock = GAME_LEN;
    this.overtime = false;                 // sudden death after a tie
    this.shotClock = SHOT_CLOCK;
    this.state = 'tip';
    this.t = 0;
    this.stateT = 0;
    this.handler = -1;
    this.poss = -1;                        // team with the ball (or that last had it)
    this.shot = null;
    this.pass = null;
    this.inb = null;
    this.assist = null;
    this.lastTouch = -1;
    this.over = false;
    this.events = [];
    this.passTarget = -1;                  // where a pass from you would go now
    this.ais = [new TeamAI(this, 0, this.mateDiff), new TeamAI(this, 1, this.diff)];
    for (const p of this.players) if (p.motion) { p.motion.danceW = 0; p.motion.dance = null; }   // the bodies are reused game to game
    this.beginTip();
  }

  // ---------- helpers ----------
  teamOf(i) { return i < TEAM_SIZE ? 0 : 1; }
  teamPlayers(t) { return t === 0 ? [0, 1, 2] : [3, 4, 5]; }
  mates(i) { return this.teamPlayers(this.teamOf(i)).filter((j) => j !== i); }
  opps(i) { return this.teamPlayers(1 - this.teamOf(i)); }
  basketOf(i) { return BASKETS[this.teamOf(i)]; }          // the basket i attacks
  rimOf(i) { return BASKETS[this.teamOf(i)].rim; }
  distToRim(p, i) { const R = this.rimOf(i); return Math.hypot(p.pos.x - R.x, p.pos.z - R.z); }
  threeAt(i, x, z) { return isThree(x, z, this.teamOf(i)); }
  // i's position in its own team's frame (its basket at (0, rimZ))
  frameOf(i, out = { x: 0, z: 0 }) { const p = this.players[i].pos; return toFrame(this.teamOf(i), p.x, p.z, out); }
  isUser(i) { return i === this.user; }
  isAI(i) { return i !== this.user || this.over; }     // after the final buzzer the AI walks everyone
  diffOf(i) { return this.teamOf(i) === 1 ? this.diff : this.mateDiff; }
  live() { return LIVE.has(this.state) && !this.over; }
  // the opponent nearest i
  nearestOpp(i, x = this.players[i].pos.x, z = this.players[i].pos.z) {
    let best = -1, bd = 1e9;
    for (const j of this.opps(i)) {
      const q = this.players[j].pos, d = Math.hypot(q.x - x, q.z - z);
      if (d < bd) { bd = d; best = j; }
    }
    return { j: best, d: bd };
  }
  focus() {
    const f = _v2;
    if (this.handler >= 0) f.copy(this.players[this.handler].pos);
    else f.set(this.ball.pos.x, 0, this.ball.pos.z);
    return f;
  }
  slowmo(scale, dur) { this.timeScale = scale; this.slowT = dur; }

  // ---------- control ----------
  // hand your team to the AI (soak tests, the debug bench) or take it back
  setAutoplay(on) {
    this.autoplay = on;
    if (on) { this.user = -1; return; }
    const h = this.handler;
    this.user = h >= 0 && this.teamOf(h) === 0 ? h : 0;
    if (!(h >= 0 && this.teamOf(h) === 0)) this.userToBall();
  }

  setUser(i) {
    if (this.autoplay || i < 0 || this.teamOf(i) !== 0 || i === this.user) return;
    const prev = this.user;
    this.user = i;
    // a fresh body: no stale stick or move from the one you left
    if (prev >= 0) { const s = this.ps[prev]; s.intent.x = s.intent.z = s.intent.mag = 0; }
    this.fx('switch', { i, from: prev });
  }
  // your team without the ball: take the player nearest it (or the next one, if that's you already)
  switchUser() {
    if (this.autoplay) return;
    const b = this.ball.pos;
    const order = [0, 1, 2].map((i) => ({ i, d: Math.hypot(this.players[i].pos.x - b.x, this.players[i].pos.z - b.z) })).sort((a, c) => a.d - c.d);
    const pick = order[0].i === this.user ? order[1].i : order[0].i;
    this.setUser(pick);
  }
  // on a change of possession to the other team, you take whoever is nearest the ball
  userToBall() {
    if (this.autoplay) return;
    const b = this.ball.pos;
    let best = this.user, bd = 1e9;
    for (const i of [0, 1, 2]) {
      const d = Math.hypot(this.players[i].pos.x - b.x, this.players[i].pos.z - b.z);
      if (d < bd) { bd = d; best = i; }
    }
    this.setUser(best);
  }

  // ---------- tip-off ----------
  beginTip() {
    this.state = 'tip';
    this.stateT = 0;
    this.handler = -1;
    this.poss = -1;
    this.shotClock = SHOT_CLOCK;
    this.shot = null; this.pass = null; this.inb = null;
    this.reboundOf = null; this.stealBy = undefined;
    for (const q of this.players) if (q.action && q.action.type === 'check') q.action = null;
    this.ball.free = false;
    this.ball.vel.set(0, 0, 0);
    this.ball.spin.set(0, 0, 0);
    const C = COURT.halfLen;
    // each side's tallest player jumps
    const tallest = (t) => this.teamPlayers(t).reduce((a, b) => (this.players[b].info.height > this.players[a].info.height ? b : a));
    this.jumpers = [tallest(0), tallest(1)];
    // team 0 defends basket B (z = len), so it lines up on that side of the circle
    const spots = [
      [[0, C + 0.5], [-3.4, C + 2.3], [3.6, C - 1.4]],
      [[0, C - 0.5], [3.4, C - 2.3], [-3.6, C + 1.4]],
    ];
    for (const t of [0, 1]) {
      const others = this.teamPlayers(t).filter((i) => i !== this.jumpers[t]);
      const order = [this.jumpers[t], ...others];
      order.forEach((i, k) => {
        const p = this.players[i];
        p.pos.set(spots[t][k][0], 0, spots[t][k][1]);
        p.vel.set(0, 0, 0);
        p.yaw = t === 0 ? Math.PI : 0;
        p.action = null; p.dribble.active = false; p.dribble.crossing = false;
        p.stance = 'offense';
      });
    }
    for (const s of this.ps) { s.off = 0; s.burst = null; s.hist.length = 0; }
    this.ball.pos.set(0, 1.9, C);
    this.tipped = false;
    this.setUser(this.jumpers[0]);
    this.fx('tipset', { overtime: this.overtime });
  }

  // a jumper's hand meets the falling ball: tap it to a teammate
  tipTap(i) {
    const p = this.players[i];
    const mates = this.mates(i);
    const j = mates.reduce((a, b) => {
      const pa = this.players[a].pos, pb = this.players[b].pos;
      return Math.hypot(pa.x - p.pos.x, pa.z - p.pos.z) < Math.hypot(pb.x - p.pos.x, pb.z - p.pos.z) ? a : b;
    });
    const q = this.players[j].pos, b = this.ball;
    const dx = q.x - b.pos.x, dz = q.z - b.pos.z, d = Math.hypot(dx, dz) || 1;
    const sp = clamp(d * 1.25, 3, 6);
    b.vel.set(dx / d * sp, 0.6, dz / d * sp);
    b.spin.set(this.rng() * 10 - 5, 0, this.rng() * 10 - 5);
    b.free = true;
    this.lastTouch = i;
    this.tipped = true;
    this.state = 'loose';
    this.stateT = 0;
    this.fx('tip', { i });
  }

  // ---------- possession flow ----------
  giveBall(i) {
    const before = this.poss;
    this.handler = i;
    this.poss = this.teamOf(i);
    this.ball.free = false;
    this.lastTouch = i;
    this.pass = null;
    const p = this.players[i];
    // a rebounder in the air comes down with it (dropping the jump would snap him to the floor)
    if (!(p.action && p.action.type === 'contest' && p.jumpY > 0.02)) p.action = null;
    p.catchT = 0;
    p.toLocal(p.catchFrom || (p.catchFrom = new THREE.Vector3()), this.ball.pos);
    p.dribble.active = true;
    p.dribble.phase = 0.9;
    p.dribble.hand = -1;
    p.dribble.crossing = false;
    this.state = 'live';
    this.stateT = 0;
    if (this.poss === 0) this.setUser(i);
    else if (before !== this.poss) this.userToBall();
    if (before !== this.poss) {
      this.shotClock = SHOT_CLOCK;
      for (const ai of this.ais) ai.onPossession(this.poss);
      this.fx('possession', { team: this.poss, i });
    }
  }

  // dead ball: the other team inbounds from (x, z) once the pause is over
  // the ball is dead: a shot, finish or pass still in the hands never leaves them
  dropHeld() {
    const h = this.handler;
    if (h >= 0) {
      const p = this.players[h], a = p.action;
      if (a && ['shoot', 'layup', 'dunk', 'pass'].includes(a.type) && !a.released && !a.slammed) p.action = null;
    }
    this.reboundOf = null;
    this.stealBy = undefined;
  }

  turnover(toTeam, why, x, z) {
    this.dropHeld();
    this.fx('turnover', { team: toTeam, why });
    this.handler = -1;
    this.ball.free = true;
    this.shot = null;
    this.pass = null;
    this.state = 'dead';
    this.stateT = 0;
    this.pending = { team: toTeam, spot: this.sideSpot(x, z), after: 0.9 };
  }

  // the nearest spot just off the court to (x, z), for a sideline or baseline inbound
  sideSpot(x, z) {
    const W = COURT.halfW, L = COURT.len;
    const dSide = W - Math.abs(x), dBase = Math.min(z, L - z);
    if (dSide < dBase || Math.abs(x) > W) return { x: Math.sign(x || 1) * (W + 0.45), z: clamp(z, 2, L - 2) };
    // baseline: not under the backboard
    let bx = clamp(x, -W + 1, W - 1);
    if (Math.abs(bx) < 1.4) bx = Math.sign(bx || 1) * 1.4;
    return { x: bx, z: z < L / 2 ? -0.45 : L + 0.45 };
  }

  // the inbound: the nearest player takes the ball out of bounds and passes it in
  beginInbound(team, spot) {
    this.state = 'inbound';
    this.stateT = 0;
    this.handler = -1;
    this.shot = null;
    this.pass = null;
    this.poss = team;
    this.reboundOf = null; this.stealBy = undefined;
    for (const q of this.players) if (q.action && q.action.type === 'check') q.action = null;
    // you're never the one sent out of bounds: you play the receiver
    const tp = this.teamPlayers(team).filter((i) => !this.isUser(i));
    const near = (list, x, z) => list.reduce((a, b) => {
      const pa = this.players[a].pos, pb = this.players[b].pos;
      return Math.hypot(pa.x - x, pa.z - z) < Math.hypot(pb.x - x, pb.z - z) ? a : b;
    });
    const by = this.pendingBy !== undefined && this.teamOf(this.pendingBy) === team ? this.pendingBy : near(tp, spot.x, spot.z);
    this.pendingBy = undefined;
    const p = this.players[by];
    p.pos.set(spot.x, 0, spot.z);
    p.vel.set(0, 0, 0);
    // face into the court
    const into = Math.abs(spot.x) > COURT.halfW ? { x: -Math.sign(spot.x), z: 0 } : { x: 0, z: spot.z < COURT.halfLen ? 1 : -1 };
    p.yaw = Math.atan2(into.x, into.z);
    p.action = null;
    p.setAction('check');
    p.dribble.active = false;
    const to = near(this.teamPlayers(team).filter((i) => i !== by), spot.x + into.x * 3, spot.z + into.z * 3);
    this.inb = { team, spot: { ...spot }, into, by, to, t: 0 };
    this.ball.free = false;
    this.ball.vel.set(0, 0, 0);
    this.lastTouch = by;
    this.shotClock = SHOT_CLOCK;
    for (const s of this.ps) { s.off = 0; s.burst = null; }
    // your team inbounds: you play the receiver (the inbound pass comes to you)
    if (team === 0) this.setUser(to);
    else this.userToBall();
    for (const ai of this.ais) ai.onPossession(team);
    this.fx('inbound', { team, by, to });
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

  // how much one defender j bothers shooter i (0..1)
  contestBy(i, j) {
    const sp = this.players[i], dp = this.players[j];
    const R = this.rimOf(i);
    const dx = dp.pos.x - sp.pos.x, dz = dp.pos.z - sp.pos.z;
    const d = Math.hypot(dx, dz);
    const tx = R.x - sp.pos.x, tz = R.z - sp.pos.z;
    const tl = Math.hypot(tx, tz) || 1;
    const front = (dx * tx + dz * tz) / (d * tl || 1); // 1 = directly between shooter and rim
    const facing = clamp(0.35 + 0.65 * (front + 1) / 2, 0, 1);
    const jumping = dp.action && dp.action.type === 'contest' ? 1 : 0.55;
    const stumbling = this.ps[j].off > 0 ? 0.3 : 1;
    return clamp((2.1 - d) / 1.35, 0, 1) * jumping * facing * stumbling;
  }
  // all the defenders: the closest contest counts in full, the others add a little
  contestOf(i) {
    const c = this.opps(i).map((j) => this.contestBy(i, j)).sort((a, b) => b - a);
    return clamp(c[0] + 0.25 * c[1] + 0.1 * c[2], 0, 1);
  }

  jumperProb(i, timing, estimate = false, at = null) {
    const p = this.players[i], r = this.ps[i].r;
    const x = at ? at.x : p.pos.x, z = at ? at.z : p.pos.z;
    const R = this.rimOf(i);
    const d = Math.hypot(x - R.x, z - R.z);
    const three = this.threeAt(i, x, z);
    const rating = d < 2.5 ? r.finish : three ? r.three : r.mid;
    let pr = this.shotBase(d) * (0.55 + 0.6 * rating / 100);
    if (timing === 'perfect') pr = 0.55 + 0.45 * pr;
    else if (timing === 'bad') pr *= 0.42;
    else if (timing === 'late') pr *= 0.2;
    let c;
    if (estimate) {
      const n = this.nearestOpp(i, x, z);
      c = clamp((2.1 - n.d) / 1.35, 0, 1) * 0.8;
    } else c = this.contestOf(i);
    pr *= 1 - 0.62 * c;
    if (!at) { const spd = Math.hypot(p.vel.x, p.vel.z); pr *= 1 - clamp(spd / 8, 0, 0.3); }
    if (this.teamOf(i) === 1) pr *= this.diff.shot;
    if (this.hot[this.teamOf(i)] === i) pr = Math.min(0.97, pr * 1.3 + 0.08);
    return clamp(pr, 0.02, 0.97);
  }

  cmdShoot(i) {
    if (this.handler !== i || this.state !== 'live') return;
    const p = this.players[i];
    if (p.action && p.action.type !== 'jab') return;
    const R = this.rimOf(i);
    const d = this.distToRim(p, i);
    const tx = (R.x - p.pos.x) / (d || 1), tz = (R.z - p.pos.z) / (d || 1);
    const toward = p.vel.x * tx + p.vel.z * tz;
    if (this.dunkOn(i) || d < 1.7 || (d < 3.4 && toward > 1.2)) this.startFinish(i);
    else this.startJumper(i);
  }

  // a full meter is yours to spend (your teammates leave it for you; the CPU team uses its own)
  canDunk(i) {
    const t = this.teamOf(i);
    return this.dunkMeter[t] >= 1 && (t === 1 || this.autoplay || i === this.user);
  }

  // SHOOT now would dunk: a full meter and a run at the rim from close enough
  dunkOn(i) {
    if (!this.canDunk(i)) return false;
    const p = this.players[i], R = this.rimOf(i);
    const d = this.distToRim(p, i);
    const toward = (p.vel.x * (R.x - p.pos.x) + p.vel.z * (R.z - p.pos.z)) / (d || 1);
    return toward > 1.6 && d > 0.6 && d < DUNK_REACH;
  }

  startJumper(i) {
    const p = this.players[i];
    const r = this.ps[i].r;
    const d = this.distToRim(p, i);
    const three = this.threeAt(i, p.pos.x, p.pos.z);
    const rating = three ? r.three : r.mid;
    let win = 0.07 + 0.09 * clamp((rating - 40) / 60, 0, 1);
    if (this.hot[this.teamOf(i)] === i) win *= 1.5;
    const jump = (0.28 + 0.22 * (r.dunk / 100)) * (d > 6 ? 0.85 : 1);
    p.dribble.active = false;
    p.setAction('shoot', { jump, air: AIR, win, released: false, three });
    this.shot = { shooter: i, team: this.teamOf(i), phase: 'rising', win, three, t: 0 };
    this.state = 'shooting';
    this.stateT = 0;
    p.vel.multiplyScalar(0.3);
    this.fx('shotstart', { i, three });
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
    if (!act || act.type !== 'shoot' || act.released) return;
    act.released = true;
    const m = act.t / T_FULL;
    const dm = m - M_APEX;
    let timing;
    if (forcedLate) timing = 'late';
    else if (Math.abs(dm) <= act.win / 2) timing = 'perfect';
    else if (Math.abs(dm) <= act.win / 2 + 0.09) timing = 'good';
    else timing = 'bad';
    if (timing === 'perfect') { this.stats[this.teamOf(i)].green++; this.pstats[i].green++; }
    this.fx('release', { i, timing, early: dm < 0 });
    const d = this.distToRim(p, i);
    const pr = this.jumperProb(i, timing);
    // block check: any defender in the air with a hand on the ball
    for (const j of this.opps(i)) {
      const dp = this.players[j];
      if (!dp.action || dp.action.type !== 'contest') continue;
      const bpos = this.ball.pos;
      const near = Math.min(dp.handWorld(1, _v).distanceTo(bpos), dp.handWorld(0, _v).distanceTo(bpos));
      if (near < 0.5 && this.rng() < 0.25 + 0.45 * (this.ps[j].r.block / 100)) { this.blocked(i, j, act.three); return; }
    }
    const make = this.rng() < pr;
    this.launch(i, make, { d, three: act.three, timing, arc: 1.0 + 0.09 * d, bad: timing === 'bad' || timing === 'late' });
  }

  launch(i, make, { d, three, arc, bad = false, soft = false, type = 'jumper' }) {
    const ball = this.ball;
    const R = this.rimOf(i);
    // aim point
    const dirx = R.x - ball.pos.x, dirz = R.z - ball.pos.z;
    const dl = Math.hypot(dirx, dirz) || 1;
    const fx = dirx / dl, fz = dirz / dl;
    let ox = 0, oz = 0;
    const rnd = (a, b) => a + this.rng() * (b - a);
    if (make) {
      const r = this.rng() * (soft ? 0.05 : 0.045), a = this.rng() * Math.PI * 2;
      ox = Math.cos(a) * r; oz = Math.sin(a) * r;
    } else {
      let r = rnd(0.17, 0.3);
      if (bad && this.rng() < 0.3) r = rnd(0.34, 0.55);
      if (this.rng() < 0.65) {
        const s = this.rng() < 0.5 ? -1 : 1;  // short / long
        const jit = rnd(-0.35, 0.35);
        const ax = fx * Math.cos(jit) - fz * Math.sin(jit), az = fx * Math.sin(jit) + fz * Math.cos(jit);
        ox = ax * r * s; oz = az * r * s;
      } else {
        const s = this.rng() < 0.5 ? -1 : 1;
        ox = -fz * r * s; oz = fx * r * s;
      }
    }
    const T = _v.set(R.x + ox, R.y + 0.02, R.z + oz);
    const P0 = ball.pos;
    const H = Math.min(6.2, Math.max(P0.y, T.y) + arc);
    const vy0 = Math.sqrt(2 * G * Math.max(0.05, H - P0.y));
    const tUp = vy0 / G;
    const tDown = Math.sqrt(2 * Math.max(0.02, H - T.y) / G);
    const tt = tUp + tDown;
    this.throwTo(T, tt);
    const hx = ball.vel.x, hz = ball.vel.z, hl = Math.hypot(hx, hz) || 1;
    ball.spin.set(-hz / hl, 0, hx / hl).multiplyScalar(18); // backspin: forward x up
    ball.free = true;
    this.handler = -1;
    this.lastTouch = i;
    this.state = 'shot';
    this.stateT = 0;
    const pts = three ? 3 : 2;
    this.shot = { shooter: i, team: this.teamOf(i), pts, made: false, rim: false, board: false, type, decided: make, t: 0, three };
    this.count(i, 'fga'); if (three) this.count(i, 'tpa');
  }

  // set the ball's velocity so it reaches T in tt seconds, through the air drag
  throwTo(T, tt) {
    const ball = this.ball, P0 = ball.pos;
    const e = (1 - Math.exp(-AIR_DRAG * tt)) / AIR_DRAG;
    ball.vel.set((T.x - P0.x) / e, (T.y - P0.y + G * tt / AIR_DRAG) / e - G / AIR_DRAG, (T.z - P0.z) / e);
  }

  count(i, key, n = 1) { this.stats[this.teamOf(i)][key] += n; this.pstats[i][key] += n; }

  blocked(shooter, blocker, three = false) {
    const ball = this.ball;
    const sp = this.players[shooter];
    const R = this.rimOf(shooter);
    const rnd = (a, b) => a + this.rng() * (b - a);
    const ax = sp.pos.x - R.x, az = sp.pos.z - R.z, al = Math.hypot(ax, az) || 1;
    ball.free = true;
    ball.vel.set((ax / al) * rnd(3.5, 5.5) + rnd(-1.5, 1.5), rnd(1.5, 3), (az / al) * rnd(3.5, 5.5) + rnd(-1.5, 1.5));
    ball.spin.set(rnd(-20, 20), rnd(-10, 10), rnd(-20, 20));
    this.handler = -1;
    this.lastTouch = blocker;
    this.state = 'loose';
    this.stateT = 0;
    this.shot = null;
    this.count(shooter, 'fga');
    if (three) this.count(shooter, 'tpa');
    this.count(blocker, 'blk');
    this.fx('block', { i: blocker, shooter });
  }

  // the ball just out of the shooter's hands, still rising: a defender in the air can swat it
  blockInFlight() {
    const sh = this.shot, b = this.ball.pos;
    for (const j of this.opps(sh.shooter)) {
      const dp = this.players[j];
      if (!dp.action || dp.action.type !== 'contest' || dp.action.swiped === sh) continue;
      const near = Math.min(dp.handWorld(0, _v).distanceTo(b), dp.handWorld(1, _v).distanceTo(b));
      if (near > 0.36) continue;
      dp.action.swiped = sh;
      if (this.rng() < 0.3 + 0.45 * (this.ps[j].r.block / 100)) {
        this.stats[sh.team].fga--; this.pstats[sh.shooter].fga--;     // blocked() counts the attempt itself
        if (sh.three) { this.stats[sh.team].tpa--; this.pstats[sh.shooter].tpa--; }
        this.blocked(sh.shooter, j, sh.three);
        return true;
      }
    }
    return false;
  }

  // drive finishes
  startFinish(i) {
    const p = this.players[i];
    const r = this.ps[i].r;
    const R = this.rimOf(i), B = this.basketOf(i);
    const d = this.distToRim(p, i);
    const tx = (R.x - p.pos.x) / (d || 1), tz = (R.z - p.pos.z) / (d || 1);
    const dunk = this.dunkOn(i);
    p.dribble.active = false;
    const start = p.pos.clone();
    const endD = dunk ? 0.62 : 0.95;
    const end = new THREE.Vector3(R.x - tx * endD, 0, R.z - tz * endD);
    // never finish behind the glass
    const inZ = (end.z - B.baseZ) * B.dir;
    if (inZ < 0.5) end.z = B.baseZ + 0.5 * B.dir;
    // a dunk goes up head-high to the glass: finish in front of it, beside the rim rather than under it
    const minZ = B.baseZ + (COURT.boardZ + 0.3) * B.dir;
    if (dunk && (end.z - minZ) * B.dir < 0) {
      end.z = minZ;
      const dz = end.z - R.z, side = Math.sign(end.x - R.x) || Math.sign(p.pos.x - R.x) || 1;
      end.x = R.x + side * Math.sqrt(Math.max(0, endD * endD - dz * dz));
    }
    if (dunk) {
      this.dunkMeter[this.teamOf(i)] = 0;
      // an earned dunk goes up well over the rim and comes down on it; a longer take-off hangs longer
      const big = clamp((d - 1.8) / 2.2, 0, 1);
      const jump = Math.max(0.5, R.y + 0.12 - 2.36 * p.s) + 0.3 + 0.1 * (r.dunk / 100) + 0.15 * big;
      p.setAction('dunk', { gather: 0.2 + 0.08 * big, air: 0.72 + 0.2 * big, jump, start, end, slammed: false, hang: false, hangT: 0, dur: 2.4, big });
    } else {
      p.setAction('layup', { gather: 0.22, air: 0.74, jump: 0.55 + 0.25 * (r.dunk / 100), start, end, released: false, dur: 1.3 });
    }
    this.state = 'finishing';
    this.stateT = 0;
    this.shot = { shooter: i, team: this.teamOf(i), type: dunk ? 'dunk' : 'layup' };
    this.fx('finishstart', { i, dunk });
  }

  finishProb(i, dunk) {
    const r = this.ps[i].r;
    const c = this.contestOf(i);
    let pr = dunk ? 0.97 - 0.12 * c : (0.5 + 0.35 * r.finish / 100) * (1 - 0.5 * c);
    if (this.teamOf(i) === 1) pr *= Math.min(1.05, this.diff.shot + 0.05);
    if (this.hot[this.teamOf(i)] === i) pr = Math.min(0.98, pr + 0.12);
    return clamp(pr, 0.05, 0.98);
  }

  checkFinishBlock(i, dunk) {
    const b = this.ball.pos;
    for (const j of this.opps(i)) {
      const dp = this.players[j];
      if (!dp.action || dp.action.type !== 'contest') continue;
      const near = Math.min(dp.handWorld(0, _v).distanceTo(b), dp.handWorld(1, _v).distanceTo(b));
      if (near > 0.6) continue;
      const pr = (0.3 + 0.5 * this.ps[j].r.block / 100) * (dunk ? 0.35 : 1);
      if (this.rng() < pr) return j;
    }
    return -1;
  }

  // ---------- passing ----------
  // how good a look j would get with the ball right now (0..1), for the AI and the auto target
  openness(j) {
    const q = this.players[j].pos;
    const n = this.nearestOpp(j);
    const shot = this.jumperProb(j, 'good', true, q);
    const R = this.rimOf(j);
    const dRim = Math.hypot(q.x - R.x, q.z - R.z);
    const lane = dRim < 3.5 && n.d > 1.4 ? 0.25 : 0;           // free run at the rim
    return clamp(shot + lane + clamp((n.d - 1) / 4, 0, 0.3), 0, 1);
  }

  // the clearest defender's distance to the line from i to j (how risky the pass is)
  laneRisk(i, j) {
    const a = this.players[i].pos, b = this.players[j].pos;
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
    let risk = 0;
    for (const k of this.opps(i)) {
      const q = this.players[k].pos;
      const u = clamp(((q.x - a.x) * dx + (q.z - a.z) * dz) / L2, 0.08, 1);
      const px = a.x + dx * u, pz = a.z + dz * u;
      const d = Math.hypot(q.x - px, q.z - pz);
      risk = Math.max(risk, clamp((1.4 - d) / 1.2, 0, 1) * (u < 0.95 ? 1 : 0.6));
    }
    return risk;
  }

  // the teammate a pass from i goes to: the one along (dx, dz) if given, else the most open
  passTargetFor(i, dx = 0, dz = 0) {
    const p = this.players[i];
    const l = Math.hypot(dx, dz);
    let best = -1, bs = -1e9;
    for (const j of this.mates(i)) {
      const q = this.players[j].pos;
      const ox = q.x - p.pos.x, oz = q.z - p.pos.z, d = Math.hypot(ox, oz) || 1;
      let sc;
      if (l > 0.3) {
        const cos = (ox * dx + oz * dz) / (d * l);
        sc = cos * 2 - d * 0.02;
      } else sc = this.openness(j) - this.laneRisk(i, j) * 0.5 - d * 0.01;
      if (sc > bs) { bs = sc; best = j; }
    }
    return best;
  }

  // lob: a high, slow pass over a defender in the lane
  cmdPass(i, j = -1, { lob = false } = {}) {
    const p = this.players[i];
    const inbound = this.state === 'inbound' && this.inb && this.inb.by === i;
    if (!inbound && (this.handler !== i || this.state !== 'live')) return false;
    if (!inbound && p.action && p.action.type !== 'jab') return false;
    if (j < 0) j = inbound ? this.inb.to : this.passTargetFor(i);
    if (j < 0 || this.teamOf(j) !== this.teamOf(i) || j === i) return false;
    p.dribble.active = false;
    p.action = null;
    p.setAction('pass', { to: j, dur: 0.42, released: false, inbound, lob });
    p.vel.multiplyScalar(0.5);
    if (inbound) this.inb.passing = true;
    return true;
  }

  // the ball leaves the passer's hands, led to where the receiver is heading
  releasePass(i) {
    const p = this.players[i], act = p.action;
    act.released = true;
    const j = act.to, q = this.players[j];
    const ball = this.ball;
    let ax = q.pos.x, az = q.pos.z, T = 0.4;
    for (let k = 0; k < 2; k++) {
      const d = Math.hypot(ax - ball.pos.x, az - ball.pos.z);
      T = d > 11 ? 0.42 + d / 24 : clamp(d / 12.5, 0.16, 1.0);
      const lead = this.isUser(j) ? 0.7 : 0.85;          // you steer yourself onto it; the AI runs to it
      ax = q.pos.x + q.vel.x * T * lead; az = q.pos.z + q.vel.z * T * lead;
    }
    ax = clamp(ax, -COURT.halfW + 0.3, COURT.halfW - 0.3);
    az = clamp(az, 0.3, COURT.len - 0.3);
    const dist = Math.hypot(ax - ball.pos.x, az - ball.pos.z);
    const lob = act.lob || dist > 11;
    if (act.lob) T = Math.max(T, 0.85 + dist / 40);       // up over the defender's hands
    this.throwTo(_v.set(ax, 1.2 * q.s + (lob ? 0.1 : 0), az), T);
    const hx = ball.vel.x, hz = ball.vel.z, hl = Math.hypot(hx, hz) || 1;
    ball.spin.set(-hz / hl, 0, hx / hl).multiplyScalar(lob ? 8 : 12);
    ball.free = true;
    this.handler = -1;
    this.lastTouch = i;
    this.state = 'pass';
    this.stateT = 0;
    this.pass = { from: i, to: j, t: 0, T, aim: { x: ax, z: az }, lob, inbound: !!act.inbound, team: this.teamOf(i) };
    for (const k of this.opps(i)) this.ps[k].triedPass = null;
    if (act.inbound) this.inb = null;
    // the receiver runs to the ball under the AI; he becomes yours on the catch (giveBall)
    this.fx('pass', { i, j, lob });
  }

  // each physics substep of a pass in the air: a catch, or a defender going for it
  passCatch() {
    const ps = this.pass, ball = this.ball, b = ball.pos;
    if (!ps) return false;
    // defenders in the lane (each gets one go at it), once it's out of the passer's hands
    for (const k of this.opps(ps.from)) {
      const s = this.ps[k];
      if (ps.t < 0.12 || s.triedPass === ps || s.off > 0) continue;
      const q = this.players[k];
      const reach = 2.25 * q.s + q.jumpY;
      const hd = Math.hypot(b.x - q.pos.x, b.z - q.pos.z);
      if (hd < 0.62 && b.y < reach && b.y > 0.35) {
        s.triedPass = ps;
        let pr = 0.12 + 0.38 * (s.r.steal / 100) + (hd < 0.35 ? 0.12 : 0);
        pr *= this.teamOf(k) === 1 ? this.diff.steal : 1;
        if (ps.lob) pr *= 0.6;
        if (ps.inbound) pr *= 0.45;          // the inbounder sees the whole floor
        if (this.rng() < clamp(pr, 0.1, 0.85)) {
          this.count(k, 'stl');
          this.fx('intercept', { i: k, from: ps.from });
          this.giveBall(k);
          return true;
        }
        // a fingertip: the ball slows and wobbles on
        if (this.rng() < 0.3 * (ps.lob ? 0.5 : 1) * (ps.inbound ? 0.5 : 1)) {
          ball.vel.multiplyScalar(0.55); ball.vel.y += 1.2;
          this.lastTouch = k;
          this.state = 'loose'; this.stateT = 0; this.pass = null;
          this.fx('deflect', { i: k });
          return true;
        }
      }
    }
    // the receiver (or a teammate in the way)
    for (const j of this.mates(ps.from)) {
      const q = this.players[j];
      const cx = q.pos.x + Math.sin(q.yaw) * 0.2, cz = q.pos.z + Math.cos(q.yaw) * 0.2, cy = 1.15 * q.s + q.jumpY;
      const d = Math.hypot(b.x - cx, b.y - cy, b.z - cz);
      const lim = j === ps.to ? 0.75 : 0.45;
      if (d < lim || (j === ps.to && ps.t > ps.T + 0.1 && Math.hypot(b.x - cx, b.z - cz) < 1.0 && b.y < 2.4)) {
        this.assist = { by: ps.from, to: j, t: this.t, team: ps.team };
        this.fx('catch', { i: j, from: ps.from });
        const wasInbound = ps.inbound;
        this.giveBall(j);
        if (wasInbound) this.shotClock = SHOT_CLOCK;
        return true;
      }
    }
    return false;
  }

  // ---------- moves & steals ----------
  cmdMove(i, stickX, stickZ) {
    const s = this.ps[i], p = this.players[i];
    if (s.moveCd > 0 || this.handler !== i || p.action || this.state !== 'live') return;
    s.moveCd = 0.6;
    const R = this.rimOf(i);
    const d = this.distToRim(p, i) || 1;
    const tx = (R.x - p.pos.x) / d, tz = (R.z - p.pos.z) / d;
    const m = Math.hypot(stickX, stickZ);
    const dot = m > 0.2 ? (stickX * tx + stickZ * tz) / m : 0;
    const n = this.nearestOpp(i);
    const dp = this.players[n.j];
    const ddx = dp.pos.x - p.pos.x, ddz = dp.pos.z - p.pos.z;
    const dd = n.d;
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
    let label;
    if (kind === 'stepback') {
      s.burst = { vx: -tx * 4.6, vz: -tz * 4.6, t: 0.28 };
      p.dribble.crossing = true; p.dribble.from = p.dribble.hand; p.dribble.phase = 0;
      label = 'STEP-BACK';
    } else if (kind === 'spin') {
      s.burst = { vx: perpX * side * burst * 0.8 + tx * 2.5, vz: perpZ * side * burst * 0.8 + tz * 2.5, t: 0.42, spin: side };
      label = 'SPIN';
    } else {
      s.burst = { vx: perpX * side * burst, vz: perpZ * side * burst, t: 0.3 };
      p.dribble.crossing = true; p.dribble.from = p.dribble.hand; p.dribble.phase = 0;
      label = side > 0 === (p.dribble.hand > 0) ? 'HESI' : 'CROSSOVER';
    }
    this.fx('move', { i, kind, label });
    // does the defender bite?
    if (dd < 2.0) {
      const j = n.j, ds = this.ps[j];
      let bite = 0.18 + (s.r.handle - ds.r.defense) / 100 * 0.9 + (dd < 1.3 ? 0.15 : 0);
      if (kind === 'stepback') bite *= 0.6;
      if (this.isAI(j)) bite *= 1.25 - this.diffOf(j).iq * 0.6; else bite *= 0.55; // you react for yourself
      if (this.rng() < clamp(bite, 0.04, 0.8)) {
        ds.off = 0.55;
        dp.setAction('stumble', { dur: 0.6 });
        this.fx('bite', { i, j, ankles: s.r.handle >= 85 && this.rng() < 0.45 });
      }
    }
  }

  // jab step: sells a drive; a jumpy defender may lean the wrong way
  cmdJab(i, side) {
    const p = this.players[i];
    if (p.action || this.handler !== i) return;
    p.setAction('jab', { side, dur: 0.55 });
    const n = this.nearestOpp(i);
    if (n.d < 1.8 && this.isAI(n.j) && this.rng() < 0.3 * (1.2 - this.diffOf(n.j).iq)) {
      this.ps[n.j].off = 0.3;
      this.fx('move', { i, kind: 'jab', label: 'JAB' });
    }
  }

  cmdSteal(i) {
    const s = this.ps[i], p = this.players[i];
    if (p.action || s.off > 0 || this.t < (s.stealCd || 0)) return;
    s.stealCd = this.t + 0.9;            // no swiping every frame
    p.setAction('steal', { dur: 0.45, checked: false });
    p.vel.multiplyScalar(0.5);
  }

  resolveSteal(i) {
    if (this.over || !this.live()) return;      // a swipe started before the buzzer or a dead ball doesn't count
    const s = this.ps[i], p = this.players[i];
    const h = this.handler;
    if (h < 0 || this.teamOf(h) === this.teamOf(i)) return;
    const hp = this.players[h];
    const b = this.ball.pos;
    const dist = Math.hypot(b.x - p.pos.x, b.z - p.pos.z);
    const hs = this.ps[h];
    if (dist > 1.25 || (hp.action && hp.action.type !== 'jab')) { this.reach(i); return; }
    let pr = 0.1 + 0.5 * (s.r.steal / 100) - 0.33 * (hs.r.handle / 100);
    if (b.y < 0.55) pr += 0.12;          // ball low and exposed
    if (hp.dribble.crossing) pr += 0.1;  // crossing in front
    if (this.teamOf(i) === 1) pr *= this.diff.steal;
    if (this.rng() < clamp(pr, 0.04, 0.6)) {
      const ball = this.ball;
      const rnd = (a, c) => a + this.rng() * (c - a);
      ball.free = true;
      const ax = b.x - hp.pos.x, az = b.z - hp.pos.z, al = Math.hypot(ax, az) || 1;
      ball.vel.set(ax / al * rnd(2, 3.5) + rnd(-1, 1), rnd(1.2, 2.4), az / al * rnd(2, 3.5) + rnd(-1, 1));
      this.handler = -1;
      hp.dribble.active = false;
      this.lastTouch = i;
      this.state = 'loose';
      this.stateT = 0;
      this.stealBy = i;
      this.fx('steal', { i, from: h });
    } else this.reach(i);
  }

  reach(i) {
    this.ps[i].off = 0.5;
    this.players[i].setAction('stumble', { dur: 0.5 });
  }

  // a block or rebound jump: a quick load, then up; a bigger leaper gets higher and hangs a touch longer
  contestShape(i) {
    const jump = 0.42 + 0.35 * (this.ps[i].r.block / 100);
    const t0 = 0.12, air = 0.46 + 0.14 * jump;
    return { t0, jump, air, peak: t0 + air / 2 };
  }

  cmdContest(i) {
    const p = this.players[i];
    if (p.action && p.action.type !== 'check') return;
    const c = this.contestShape(i);
    p.setAction('contest', { t0: c.t0, jump: c.jump, air: c.air, dur: c.t0 + c.air + 0.2 });
    p.vel.multiplyScalar(0.4);
  }

  // ---------- main update ----------
  update(dt, realDt) {
    this.t += dt;
    this.stateT += dt;
    if (this.slowT > 0) { this.slowT -= realDt; if (this.slowT <= 0) this.timeScale = 1; }
    if (this.live()) this.tickClocks(dt);
    this.chargeDunks(realDt);
    const inp = this.input.poll(realDt);
    if (!this.autoplay) this.humanInput(inp, dt);
    for (const ai of this.ais) ai.update(dt);      // (at the end its 'over' branch stops everyone)
    this.updatePlayers(dt);
    this.updateBall(dt);
    this.updateRules(dt);
    for (const n of this.nets) n.update(dt, this.ball);
    this.input.endFrame();
  }

  // dunks are earned: 15 seconds of play fills the meter (real seconds, through dead balls
  // and slow motion; it stops while paused and during replays), and a dunk spends it
  chargeDunks(dt) {
    if (this.frozen || this.over || this.state === 'tip') return;
    for (let t = 0; t < 2; t++) {
      if (this.dunkMeter[t] >= 1) continue;
      this.dunkMeter[t] = Math.min(1, this.dunkMeter[t] + dt / DUNK_CHARGE);
      if (this.dunkMeter[t] >= 1) this.fx('dunkready', { team: t });
    }
  }

  tickClocks(dt) {
    if (this.frozen) return;                                              // the debug bench
    if (this.state === 'pass' && this.pass && this.pass.inbound) return;   // starts on the catch
    if (this.state !== 'shot') this.shotClock = Math.max(0, this.shotClock - dt);
    if (this.overtime) return;                                            // sudden death: no game clock
    this.clock = Math.max(0, this.clock - dt);
    if (this.clock <= 0) {
      if (!this.buzzer) { this.buzzer = true; this.fx('buzzer', { final: true }); }
      // a shot already in the air still counts; anything else ends it now
      if (this.state !== 'shot') this.endOfTime();
    }
  }

  // regulation is over: a winner, or sudden death from a new tip
  endOfTime() {
    if (this.over) return;
    this.dropHeld();
    if (this.score[0] !== this.score[1]) { this.finish(this.score[0] > this.score[1] ? 0 : 1); return; }
    this.overtime = true;
    this.buzzer = false;
    this.state = 'dead';
    this.stateT = 0;
    this.handler = -1;
    this.shot = null; this.pass = null;
    this.ball.free = true;
    this.pending = { tip: true, after: 1.6 };
    this.fx('overtime', {});
  }

  humanInput(inp, dt) {
    const i = this.user;
    if (i < 0) return;
    const p = this.players[i];
    // camera-relative stick -> world
    const cam = this.threeCamera;
    cam.getWorldDirection(_v);
    const fx = _v.x, fz = _v.z, fl = Math.hypot(fx, fz) || 1;
    const fwx = fx / fl, fwz = fz / fl;
    const rtx = -fwz, rtz = fwx;
    const wx = rtx * inp.x - fwx * inp.y;
    const wz = rtz * inp.x - fwz * inp.y;
    const s = this.ps[i];
    s.intent.x = wx; s.intent.z = wz; s.intent.mag = inp.mag; s.intent.sprint = inp.sprint;
    const A = this.input.btn.a, B = this.input.btn.b, C = this.input.btn.c;
    this.passTarget = -1;
    if (this.over) { this.input.setLabels(['', '', ''], [true, true, true]); return; }
    const st = this.state;
    const mine = this.handler === i;
    const ourBall = this.poss === 0 && (this.handler >= 0 || st === 'pass' || st === 'inbound');

    if (st === 'tip') {
      this.input.setLabels(['JUMP', '', ''], [i !== this.jumpers[0], true, true]);
      if (A.pressed && i === this.jumpers[0] && !this.tipped) this.cmdContest(i);
      return;
    }
    if (mine && st === 'live') {
      this.passTarget = this.passTargetFor(i, inp.mag > 0.3 ? wx : 0, inp.mag > 0.3 ? wz : 0);
      this.input.setLabels([this.dunkOn(i) ? 'DUNK' : 'SHOOT', 'PASS', 'MOVE'], [false, false, false]);
      if (A.pressed) this.cmdShoot(i);
      else if (B.pressed) this.cmdPass(i, this.passTarget);
      else if (C.pressed) this.cmdMove(i, wx, wz);
      return;
    }
    if (st === 'shooting' && this.shot && this.shot.shooter === i) {
      this.input.setLabels(['SHOOT', 'PASS', 'MOVE'], [false, true, true]);
      if (A.released || !A.down) this.releaseJumper(i);
      return;
    }
    if (st === 'inbound' && this.inb && this.inb.team === 0) {
      // you're the receiver: call for it
      this.input.setLabels(['', 'CALL', ''], [true, false, true]);
      if (B.pressed && this.inb.t > 0.3) this.cmdPass(this.inb.by, i);
      return;
    }
    if (ourBall) {
      // a teammate's pass on its way to you, or your shot in the air
      this.input.setLabels(['JUMP', '', ''], [false, true, true]);
      if (A.pressed) this.cmdContest(i);
      return;
    }
    const loose = st === 'loose' || (st === 'shot' && this.ball.free);
    if (loose) this.input.setLabels(['JUMP', 'SWITCH', 'STEAL'], [false, false, true]);
    else this.input.setLabels(['BLOCK', 'SWITCH', 'STEAL'], [false, false, false]);
    if (B.pressed) { this.switchUser(); return; }
    if (A.pressed) this.cmdContest(i);
    if (C.pressed && this.handler >= 0 && this.teamOf(this.handler) === 1) this.cmdSteal(i);
  }

  updatePlayers(dt) {
    const ball = this.ball;
    const N = this.players.length;
    const handler = this.handler;
    for (let i = 0; i < N; i++) {
      const p = this.players[i], s = this.ps[i];
      const team = this.teamOf(i);
      s.moveCd = Math.max(0, s.moveCd - dt);
      s.off = Math.max(0, s.off - dt);
      s.squeakCd = Math.max(0, s.squeakCd - dt);
      const act = p.action;
      const inbounder = this.state === 'inbound' && this.inb && this.inb.by === i;
      const locked = (act && ['shoot', 'layup', 'dunk', 'contest', 'check'].includes(act.type)) || inbounder;   // a pass goes on the run
      // desired velocity
      const hasBall = handler === i;
      const r = s.r;
      let max = (s.intent.sprint ? 6.2 : 4.4) * (0.78 + 0.3 * r.speed / 100);
      if (hasBall) max *= 0.92;
      if (p.stance === 'defense' && !s.intent.sprint) max *= 0.95;
      max *= this.isAI(i) ? this.diffOf(i).speed : 1;
      if (s.off > 0) max *= 0.25;
      if (this.state === 'tip' && !this.tipped) max = 0;
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
      } else if (!inbounder) {
        p.pos.x += p.vel.x * dt;
        p.pos.z += p.vel.z * dt;
      }
      // squeaks on hard cuts
      const spd = Math.hypot(p.vel.x, p.vel.z);
      const dir = Math.atan2(p.vel.x, p.vel.z);
      if (spd > 3 && s.squeakCd <= 0) {
        const dd = Math.abs(Math.atan2(Math.sin(dir - s.lastDir), Math.cos(dir - s.lastDir)));
        if (dd > 0.9) { this.fx('squeak', { i, x: p.pos.x, z: p.pos.z }); s.squeakCd = 0.35; }
      }
      if (spd > 0.5) s.lastDir = dir;
      // stance: crouched only when guarding near the ball; upright when running the floor
      const theirBall = handler >= 0 && this.teamOf(handler) !== team;
      const hp = handler >= 0 ? this.players[handler] : null;
      const dBall = Math.hypot(ball.pos.x - p.pos.x, ball.pos.z - p.pos.z);
      if (!theirBall || dBall > 7.5 || spd > 4.8) s.guard = false;
      else if (dBall < 6 && spd < 3.6) s.guard = true;
      p.stance = s.guard ? 'defense' : 'offense';
      // facing
      const R = this.rimOf(i);
      let ty;
      const sp = this.over && !(act && ['shoot', 'layup', 'dunk', 'contest'].includes(act.type)) && p.jumpY < 0.02 ? this.endSpot(i) : null;
      if (inbounder) ty = p.yaw;
      else if (act && act.type === 'dance') ty = act.yaw;
      else if (sp && spd > 0.6) ty = dir;                       // walking to the spot
      else if (sp) ty = sp.off ? Math.PI : Math.atan2(this.endStage.x - p.pos.x, this.endStage.z + 14 - p.pos.z);   // losers turn away; winners face the camera
      else if (hasBall || (act && (act.type === 'shoot' || act.type === 'layup' || act.type === 'dunk'))) {
        const toRim = Math.atan2(R.x - p.pos.x, R.z - p.pos.z);
        ty = spd > 3.2 && !act ? dir : toRim;
        if (spd > 1 && spd <= 3.2 && !act) {
          // mostly face the rim, lean into movement
          const d0 = Math.atan2(Math.sin(dir - toRim), Math.cos(dir - toRim));
          ty = toRim + clamp(d0, -1.1, 1.1) * 0.5;
        }
      } else if (act && act.type === 'pass') {
        const q = this.players[act.to].pos;
        ty = Math.atan2(q.x - p.pos.x, q.z - p.pos.z);
      } else if (spd > 3.6 && dBall > 5) {
        ty = dir;                                       // running the floor
      } else if (theirBall && dBall < 4) {
        ty = Math.atan2(hp.pos.x - p.pos.x, hp.pos.z - p.pos.z);
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
      if (hasBall) p.lookAt.copy(R);
      else if (theirBall && dBall < 4) p.lookAt.copy(hp.pos).setY(1.3);
      else p.lookAt.copy(ball.pos);
      // bounds (the inbounder stands out of bounds)
      if (!inbounder) {
        p.pos.x = clamp(p.pos.x, -COURT.halfW - 0.35, COURT.halfW + 0.35);
        p.pos.z = clamp(p.pos.z, -0.35, COURT.len + 0.35);
      }
      // keep history (defender reaction lag)
      s.hist.push({ t: this.t, x: p.pos.x, z: p.pos.z });
      while (s.hist.length > 2 && this.t - s.hist[0].t > 0.8) s.hist.shift();
    }
    // body collision, every pair
    for (let a = 0; a < N; a++) {
      for (let b = a + 1; b < N; b++) {
        const A = this.players[a], B = this.players[b];
        const dx = B.pos.x - A.pos.x, dz = B.pos.z - A.pos.z;
        const d = Math.hypot(dx, dz), minD = 0.36 * (A.s + B.s);
        if (d >= minD || d < 1e-4) continue;
        const push = minD - d;
        const nx = dx / d, nz = dz / d;
        const inbA = this.state === 'inbound' && this.inb && this.inb.by === a;
        const inbB = this.state === 'inbound' && this.inb && this.inb.by === b;
        const dance = (q) => q.action && q.action.type === 'dance';   // a dancer holds his mark; walkers go round
        const aFix = A.jumpY > 0.05 || inbA || dance(A), bFix = B.jumpY > 0.05 || inbB || dance(B);
        const wa = aFix ? 0 : bFix ? 1 : 0.5, wb = bFix ? 0 : aFix ? 1 : 0.5;
        A.pos.x -= nx * push * wa; A.pos.z -= nz * push * wa;
        B.pos.x += nx * push * wb; B.pos.z += nz * push * wb;
      }
    }

    // animate + ball attachment + IK
    for (let i = 0; i < N; i++) {
      const p = this.players[i];
      const hasBall = handler === i;
      p.dribble.active = hasBall && (!p.action || p.action.type === 'jab');
      if (p.dribble.active) {
        const spd = Math.hypot(p.vel.x, p.vel.z);
        const rate = p.dribble.crossing ? 2.9 : 1.75 + spd * 0.27;
        const prev = p.dribble.phase;
        p.dribble.phase += dt * rate;
        if (prev < 0.45 && p.dribble.phase >= 0.45) this.fx('dribble', { i, v: 0.8 + spd * 0.1, x: p.pos.x, z: p.pos.z });
        if (p.dribble.phase >= 1) {
          p.dribble.phase -= 1;
          if (p.dribble.crossing) { p.dribble.crossing = false; p.dribble.hand = -p.dribble.from; }
        }
      }
      p.animate(dt);
    }
    for (let i = 0; i < N; i++) this.attach(i, dt);
    for (const p of this.players) p.applyIK(dt);
  }

  // ball position / hand targets for the player holding it, plus action timelines
  attach(i, dt) {
    const p = this.players[i], ball = this.ball, act = p.action, s = p.s;
    const hasBall = this.handler === i;
    const R = this.rimOf(i);
    // --- inbounder holding the ball out of bounds ---
    if (this.state === 'inbound' && this.inb && this.inb.by === i && !(act && act.type === 'pass')) {
      p.localToWorld(ball.pos, 0, 1.12 * s, 0.34 * s);
      p.ikTarget[0] = p.localToWorld(new THREE.Vector3(), 0.1 * s, 1.1 * s, 0.3 * s);
      p.ikTarget[1] = p.localToWorld(new THREE.Vector3(), -0.1 * s, 1.1 * s, 0.3 * s);
      return;
    }
    // --- pass: two hands at the chest, then push through toward the target ---
    if (act && act.type === 'pass') {
      if (!act.released) {
        const e = clamp(act.t / PASS_WIND, 0, 1);
        p.localToWorld(ball.pos, 0, 1.18 * s, (0.3 + 0.12 * e) * s);
        p.ikTarget[0] = ball.pos.clone().add(_v.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(0.11));
        p.ikTarget[1] = ball.pos.clone().add(_v.set(-Math.cos(p.yaw), 0, Math.sin(p.yaw)).multiplyScalar(0.11));
        if (act.t >= PASS_WIND) this.releasePass(i);
      } else if (act.t < PASS_WIND + 0.22) {
        const reach = p.localToWorld(new THREE.Vector3(), 0, 1.25 * s, 0.62 * s);
        p.ikTarget[0] = reach.clone().add(_v.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(0.12));
        p.ikTarget[1] = reach.add(_v.set(-Math.cos(p.yaw), 0, Math.sin(p.yaw)).multiplyScalar(0.12));
      }
      return;
    }
    // --- receiver: hands up as a target, then reaching out to meet the ball ---
    if (this.state === 'pass' && this.pass && this.pass.to === i && !act) {
      const chest = p.localToWorld(new THREE.Vector3(), 0, 1.22 * s + p.jumpY, 0.34 * s);
      const d = ball.pos.distanceTo(chest);
      if (d < 4.5) {
        const reach = clamp((2.2 - d) / 1.6, 0, 1);
        const h = chest.clone().lerp(ball.pos, reach * 0.85);
        _v2.subVectors(h, chest);
        if (_v2.length() > 0.42 * s) h.copy(chest).addScaledVector(_v2.normalize(), 0.42 * s);   // as far as the arms go
        const side = _v.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(0.12 * s);
        p.ikTarget[0] = h.clone().add(side);
        p.ikTarget[1] = h.sub(side);
      }
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
      else if (this.isAI(i) && act.aiRelease !== undefined && act.t >= act.aiRelease) this.releaseJumper(i);
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
          const make = this.rng() < this.finishProb(i, false);
          this.launch(i, make, { d: this.distToRim(p, i), three: false, arc: 0.55, soft: true, type: 'layup' });
        }
      } else if ((act.t - act.gather) / act.air < 0.7) {
        // the arm stays up after the release and comes down with him
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
          const rimTop = _v.set(R.x + (p.pos.x - R.x) * 0.18, R.y + 0.25, R.z + (p.pos.z - R.z) * 0.18);   // over the front of the rim
          ball.pos.lerpVectors(back, rimTop, k * k);
          p.ikTarget[1] = ball.pos.clone().add(_v2.set(0, 0.08, 0));
        }
        if (act.t >= slamT) {
          act.slammed = true;
          const blockedBy = this.checkFinishBlock(i, true);
          if (blockedBy >= 0) { this.blocked(i, blockedBy); act.hang = false; return; }
          const make = this.rng() < this.finishProb(i, true);
          const rnd = (a, b) => a + this.rng() * (b - a);
          ball.free = true;
          this.handler = -1;
          this.lastTouch = i;
          this.state = 'shot';
          this.stateT = 0;
          this.count(i, 'fga');
          this.shot = { shooter: i, team: this.teamOf(i), pts: 2, made: false, rim: false, type: 'dunk', t: 0, three: false, big: act.big };
          const B = this.basketOf(i);
          if (make) {
            ball.pos.set(R.x + rnd(-0.03, 0.03), R.y + 0.16, R.z + rnd(-0.03, 0.03));
            ball.vel.set(0, -7, 0);
            act.hang = true; act.hangT = 0; act.made = true;
            act.hangY = R.y + 0.02 - 2.36 * s;
            act.hangFrom = p.jumpY;              // he comes down onto the rim from over it
            this.slowmo(0.35, 0.9);
            this.fx('slam', { i, big: act.big });
          } else {
            this.shot.rim = true;
            ball.pos.set(R.x, R.y + 0.2, R.z + 0.15 * B.dir);
            ball.vel.set(rnd(-2, 2), rnd(3, 4.5), rnd(1.5, 3) * B.dir);
            this.fx('rim', { v: 3, x: R.x, z: R.z, b: B.i });
          }
        }
      } else if (act.hang) {
        act.hangT += dt;
        const dir = _v.set(p.pos.x - R.x, 0, p.pos.z - R.z).normalize();
        const perp = _v2.set(-dir.z, 0, dir.x);
        p.ikTarget[0] = new THREE.Vector3(R.x + dir.x * 0.2 + perp.x * 0.12, R.y + 0.02, R.z + dir.z * 0.2 + perp.z * 0.12);
        p.ikTarget[1] = new THREE.Vector3(R.x + dir.x * 0.2 - perp.x * 0.12, R.y + 0.02, R.z + dir.z * 0.2 - perp.z * 0.12);
        if (act.hangT > 0.45 + 0.25 * (act.big || 0)) { act.hang = false; act.dropT = 0; act.dropFrom = act.hangY; }
      } else if (act.dropT !== undefined) {
        // let go of the rim and fall to the floor
        act.dropT += dt;
        act.hangY = Math.max(0, act.dropFrom - 0.5 * G * act.dropT * act.dropT);
        if (act.hangY <= 0) { p.action = null; if (act.made) p.setAction('celebrate', { dur: 1.1 }); }
      }
      return;
    }
    if (act && act.type === 'contest' && hasBall) {
      // came down with the rebound: both hands on it at the forehead, then into the dribble
      p.localToWorld(ball.pos, 0, 1.78 * s + p.jumpY, 0.24 * s);
      const side = _v.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(0.12 * s);
      p.ikTarget[0] = ball.pos.clone().add(side);
      p.ikTarget[1] = ball.pos.clone().sub(side);
      p.catchT = 0;
      p.toLocal(p.catchFrom, ball.pos);
      return;
    }
    if (act && act.type === 'contest') {
      // the arms swing up with the take-off: low and back while loading, then the hand
      // on the ball's side goes highest and the other a little lower
      const t0 = act.t0 ?? 0.1;
      const e = clamp((act.t - t0 + 0.05) / 0.17, 0, 1), k = e * e * (3 - 2 * e);
      const bx = ball.pos.x - p.pos.x, bz = ball.pos.z - p.pos.z;
      const leftLead = bx * Math.cos(p.yaw) - bz * Math.sin(p.yaw) > 0;      // +x is the character's left
      const hi = lerp(0.95 * s, 2.28 * s, k) + p.jumpY, lo = lerp(0.9 * s, 2.02 * s, k) + p.jumpY;
      const fwd = lerp(0.12, 0.3, k) * s, wide = lerp(0.26, 0.17, k) * s;
      p.ikTarget[0] = p.localToWorld(new THREE.Vector3(), wide, 0, fwd).setY(leftLead ? hi : lo);
      p.ikTarget[1] = p.localToWorld(new THREE.Vector3(), -wide, 0, fwd).setY(leftLead ? lo : hi);
      // the tip: a hand on the falling ball taps it to a teammate
      if (this.state === 'tip' && !this.tipped && this.jumpers.includes(i) && this.ball.free && this.ball.vel.y < 0) {
        const hb = Math.min(p.handWorld(0, _v).distanceTo(ball.pos), p.handWorld(1, _v2).distanceTo(ball.pos));
        if (hb < 0.42) this.tipTap(i);
      }
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
      // just caught it: the ball eases from where it was into both hands, then the dribble starts
      if (p.catchT < CATCH_T) {
        p.catchT += dt;
        const e = clamp(p.catchT / CATCH_T, 0, 1), k = e * e * (3 - 2 * e);
        const c = p.catchFrom;
        ball.pos.lerpVectors(p.localToWorld(_v2, c.x, c.y, c.z), ball.pos, k);
        const side = _v.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(0.12 * s);
        p.ikTarget[0] = ball.pos.clone().add(side);
        p.ikTarget[1] = ball.pos.clone().sub(side);
        p.dribble.phase = 0.9;
        return;
      }
      const hand = ball.pos.clone();
      hand.y = Math.max(ball.pos.y + BALL_R * 0.95, 0.66 * s);
      const idx = p.dribble.crossing ? (p.dribble.phase < 0.45 ? (p.dribble.from > 0 ? 0 : 1) : (p.dribble.from > 0 ? 1 : 0)) : (p.dribble.hand > 0 ? 0 : 1);
      p.ikTarget[idx] = hand;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      ball.spin.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw)).multiplyScalar(4 + sp * 2.5); // roll forward
    }
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
        if (this.state === 'shot' && this.shot && this.shot.type === 'jumper' && this.shot.t < 0.4 && ball.vel.y > 0 && this.blockInFlight()) break;
        // score detection, at the basket the shooter attacks
        if (this.shot && !this.shot.made && this.state === 'shot') {
          const R = BASKETS[this.shot.team].rim;
          if (ball.prev.y >= R.y && ball.pos.y < R.y && ball.vel.y < 0 &&
              Math.hypot(ball.pos.x - R.x, ball.pos.z - R.z) < COURT.rimR - 0.012) this.scored();
        }
        if (this.state === 'pass') {
          this.pass.t += h;
          if (this.passCatch()) break;
        }
      }
      for (const e of ev) {
        if (e.type === 'rim') { this.fx('rim', { v: e.v, x: ball.pos.x, z: ball.pos.z, b: e.b }); if (this.shot) this.shot.rim = true; this.nets[e.b].energy = 1; }
        else if (e.type === 'board') { this.fx('board', { v: e.v, x: ball.pos.x, z: ball.pos.z, b: e.b }); if (this.shot) this.shot.board = true; }
        else if (e.type === 'floor') {
          this.fx('bounce', { v: Math.min(2, e.v / 3), x: ball.pos.x, z: ball.pos.z });
          this.onFloor();
        }
      }
    }
    ball.sync(dt);
  }

  onFloor() {
    const b = this.ball.pos;
    // a pass that lands is a loose ball
    if (this.state === 'pass') { this.state = 'loose'; this.stateT = 0; this.pass = null; }
    if (inBounds(b.x, b.z)) return;
    if (!['loose', 'shot', 'tip'].includes(this.state)) return;
    if (this.state === 'shot' && this.shot && this.shot.made) return;
    const lt = this.lastTouch;
    const to = lt >= 0 ? 1 - this.teamOf(lt) : this.poss >= 0 ? 1 - this.poss : 0;
    this.turnover(to, 'Out of bounds', b.x, b.z);
  }

  scored() {
    if (this.over) return;
    const sh = this.shot;
    sh.made = true;
    const i = sh.shooter, team = sh.team;
    this.score[team] += sh.pts;
    this.count(i, 'pts', sh.pts);
    this.count(i, 'fgm'); if (sh.pts === 3) this.count(i, 'tpm');
    if (sh.type === 'dunk') this.count(i, 'dunks');
    // an assist: a pass caught and scored from inside 4 s
    const as = this.assist;
    if (as && as.to === i && as.team === team && this.t - as.t < 4) this.count(as.by, 'ast');
    this.assist = null;
    // the hot hand: three in a row while the other team hasn't scored
    const other = 1 - team;
    for (const k of this.teamPlayers(other)) this.ps[k].streak = 0;
    if (this.hot[other] >= 0) { this.fx('cool', { i: this.hot[other] }); this.hot[other] = -1; }
    this.ps[i].streak++;
    if (this.ps[i].streak >= 3 && this.hot[team] !== i) {
      if (this.hot[team] >= 0) this.fx('cool', { i: this.hot[team] });
      this.hot[team] = i;
      this.fx('hot', { i });
    }
    const clean = !sh.rim && !sh.board;
    const winning = this.overtime || (this.buzzer && this.score[team] > this.score[other]);
    this.fx('score', { i, team, pts: sh.pts, type: sh.type, clean, board: sh.board, winning, buzzer: !!this.buzzer, big: sh.big });
    this.state = 'dead';
    this.stateT = 0;
    // the other team takes it out under this basket
    const B = BASKETS[team];
    const side = this.rng() < 0.5 ? -1 : 1;
    this.pending = { team: other, spot: { x: side * 1.5, z: B.baseZ - 0.45 * B.dir }, after: 0.9 };
    // your threes and dunks get a replay (before the final card on a game winner)
    if (team === 0 && (sh.pts === 3 || sh.type === 'dunk') && this.onHighlight) this.onHighlight({ type: sh.type === 'dunk' ? 'dunk' : 'three', shooter: i, defender: this.nearestOpp(i).j, tMake: this.t, winning });
    if (winning) this.finish(team);
    else if (this.buzzer) this.endOfTime();
    else if (sh.type !== 'dunk' && !this.players[i].action) this.players[i].setAction('celebrate', { dur: 1.0 });
  }

  finish(winner) {
    if (this.over) return;
    this.dropHeld();
    for (const q of this.players) if (q.action && q.action.type === 'steal') q.action = null;
    this.over = true;
    this.state = 'over';
    this.stateT = 0;
    this.winner = winner;
    this.endStage = this.stageFor(winner);
    // whoever has the ball lets it go: a winner throws it up, a loser drops it
    if (this.handler >= 0) {
      const p = this.players[this.handler], up = this.teamOf(this.handler) === winner;
      this.handler = -1;
      p.dribble.active = false;
      this.ball.free = true;
      this.ball.vel.set((this.rng() - 0.5) * 1.5, up ? 7.5 : 1, (this.rng() - 0.5) * 1.5);
    }
    this.slowmo(0.35, 1.2);
    this.fx('end', { winner });
    this.onEnd({ youWon: winner === 0, score: this.score.slice(), stats: this.stats, pstats: this.pstats, overtime: this.overtime });
  }

  // the winners meet in a line at centre court and dance for the camera; the losers walk off to the far baseline
  stageFor(winner) {
    const z = COURT.halfLen - 4;
    const spots = [];
    const order = (t) => this.teamPlayers(t).slice().sort((a, b) => this.players[a].pos.x - this.players[b].pos.x);
    order(winner).forEach((i, k) => {
      const x = (k - 1) * 1.05;
      spots[i] = { x, z: z + (k === 1 ? 0.35 : 0), dance: DANCES[k], yaw: Math.atan2(-x, 14) };
    });
    order(1 - winner).forEach((i, k) => { spots[i] = { x: [-6, -4.6, 5.4][k], z: 1.4 + 0.5 * k, off: true }; });
    return { x: 0, z, spots };
  }
  endSpot(i) { return this.endStage ? this.endStage.spots[i] : null; }

  updateEnd() {
    for (const i of this.teamPlayers(this.winner)) {
      const p = this.players[i], sp = this.endStage.spots[i];
      if (p.action || Math.hypot(p.pos.x - sp.x, p.pos.z - sp.z) > 0.4) continue;
      // a body without the mocap library can't dance: fist pumps instead
      if (p.motion && p.motion.lib.clips[sp.dance]) p.setAction('dance', { clip: sp.dance, yaw: sp.yaw });
      else p.setAction('celebrate', { dur: 1.2 });
    }
  }

  // ---------- rules ----------
  updateRules(dt) {
    const ball = this.ball;
    const st = this.state;
    if (st === 'over') { this.updateEnd(); return; }
    if (st === 'tip') {
      // the ball goes up after a beat; nobody tips it, it drops loose
      if (!ball.free && this.stateT > 0.9) {
        ball.free = true;
        ball.vel.set(0, 6.4, 0);
        ball.spin.set(0, 3, 0);
        this.fx('toss', {});
      }
      if (ball.free && !this.tipped && ball.vel.y < 0 && ball.pos.y < 1.3) {
        this.tipped = true;
        this.state = 'loose';
        this.stateT = 0;
      }
      return;
    }
    if (st === 'inbound') {
      const inb = this.inb;
      inb.t += dt;
      // the inbounder can't wait for ever: in it goes to the nearest teammate
      if (!inb.passing && inb.t > 3) {
        const by = inb.by;
        const p = this.players[by].pos;
        inb.to = this.mates(by).reduce((a, b) => {
          const pa = this.players[a].pos, pb = this.players[b].pos;
          return Math.hypot(pa.x - p.x, pa.z - p.z) < Math.hypot(pb.x - p.x, pb.z - p.z) ? a : b;
        });
        this.cmdPass(by, inb.to, { lob: true });
      }
      return;
    }
    if (st === 'live') {
      if (this.shotClock <= 0 && (!this.buzzer || this.overtime)) {
        const h = this.handler >= 0 ? this.players[this.handler].pos : ball.pos;
        this.turnover(1 - this.poss, 'Shot clock', h.x, h.z);
      }
      return;
    }
    if (st === 'shooting' || st === 'finishing') return;
    if (st === 'pass') {
      if (this.pass && this.pass.t > this.pass.T + 1.2) { this.state = 'loose'; this.stateT = 0; this.pass = null; }
      return;
    }
    if (st === 'shot') {
      const sh = this.shot;
      if (sh) sh.t += dt;
      const R = BASKETS[sh.team].rim;
      // once the ball is below the rim and falling (or an air ball lands), it's a live rebound
      if (!sh.made && ((sh.rim || sh.board) && ball.vel.y < 0 && ball.pos.y < R.y - 0.1 || ball.pos.y < 1.2 && sh.t > 0.3)) {
        this.fx('miss', { i: sh.shooter, team: sh.team, air: !sh.rim && !sh.board });
        this.state = 'loose';
        this.stateT = 0;
        this.reboundOf = sh;
        // the buzzer went with it in the air, and it missed
        if (this.buzzer) { this.endOfTime(); return; }
      }
      if (sh && !sh.made && sh.rim && ball.vel.y < 0 && ball.pos.y < R.y + 0.1) this.grabCheck();
      return;
    }
    if (st === 'loose') {
      this.grabCheck();
      return;
    }
    if (st === 'dead') {
      const pd = this.pending;
      // the inbounder walks to the spot while the ball is dead
      if (pd && pd.spot) {
        const tp = this.teamPlayers(pd.team).filter((i) => !this.isUser(i));
        if (this.pendingBy === undefined || this.teamOf(this.pendingBy) !== pd.team || this.isUser(this.pendingBy)) {
          this.pendingBy = tp.reduce((a, b) => {
            const pa = this.players[a].pos, pb = this.players[b].pos;
            return Math.hypot(pa.x - pd.spot.x, pa.z - pd.spot.z) < Math.hypot(pb.x - pd.spot.x, pb.z - pd.spot.z) ? a : b;
          });
        }
      }
      if (pd && this.stateT > pd.after) {
        const by = this.pendingBy;
        const ready = !pd.spot || by === undefined || Math.hypot(this.players[by].pos.x - pd.spot.x, this.players[by].pos.z - pd.spot.z) < 0.9 || this.stateT > pd.after + 1.5;
        if (!ready) return;
        this.pending = null;
        if (pd.tip) this.beginTip();
        else this.beginInbound(pd.team, pd.spot);
      }
    }
  }

  grabCheck() {
    const ball = this.ball;
    let best = -1, bestD = 1e9;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (this.ps[i].off > 0.3) continue;
      if (this.shot && this.shot.shooter === i && this.state === 'shot' && this.shot.t < 0.4) continue;
      const reach = 2.42 * p.s + p.jumpY;
      const dxz = Math.hypot(ball.pos.x - p.pos.x, ball.pos.z - p.pos.z);
      if (ball.pos.y < reach && dxz < 0.6 + (p.jumpY > 0.1 ? 0.15 : 0)) {
        const score = dxz - p.jumpY * 0.8 - (this.isUser(i) ? 0.05 : 0);
        if (score < bestD) { bestD = score; best = i; }
      }
    }
    if (best < 0) return;
    const sh = this.shot || this.reboundOf;
    const offReb = sh && this.teamOf(best) === sh.team;
    const stolen = this.stealBy === best;
    if (stolen) this.count(best, 'stl');
    this.stealBy = undefined;
    const rim = sh && sh.rim;
    this.shot = null;
    this.reboundOf = null;
    const changed = this.teamOf(best) !== this.poss;
    this.giveBall(best);
    if (!changed && rim) this.shotClock = SHOT_CLOCK;   // a board off the rim resets it
    if (offReb) this.fx('offreb', { i: best });
    else if (sh) this.fx('rebound', { i: best });
  }

  // renderer rebuild support
  snapshot() {
    const pd = this.state === 'dead' && this.pending;
    const poss = pd ? (pd.tip ? -1 : pd.team) : this.state === 'tip' ? -1 : this.poss;
    return { score: this.score.slice(), stats: this.stats, pstats: this.pstats, poss, clock: this.clock, overtime: this.overtime, hot: this.hot.slice() };
  }
  restore(s) {
    Object.assign(this, { score: s.score, stats: s.stats, pstats: s.pstats, clock: s.clock, overtime: s.overtime, hot: s.hot });
    this.pending = null;
    if (s.poss >= 0) {
      const B = BASKETS[1 - s.poss];
      this.beginInbound(s.poss, { x: 1.5, z: B.baseZ - 0.45 * B.dir });
    } else this.beginTip();
  }
  rebind(o) { Object.assign(this, o); }
  dispose() {}
}
