// Team AI: one brain per team drives every player the user isn't controlling.
// On offence it pushes the ball up the floor, spaces the floor, cuts, passes to
// the open man and picks its shots; on defence it plays man-to-man with help on
// drives, closes out on shooters and jumps passing lanes; on misses it crashes
// the glass or gets back. It only ever steers through intents and commands.
//
// Positions are worked out in a team's frame (court.js): the basket that team
// attacks at (0, rimZ), its own basket at (0, len - rimZ). So "frame z" is the
// distance up the floor from the basket being attacked.
import { COURT, toFrame, fromFrame } from './court.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const L = COURT.len, RZ = COURT.rimZ;

// shooting spots in the attacking frame: corners, wings, slots, top
const SPOTS = [[-6.6, 1.7], [6.6, 1.7], [-5.5, 6.2], [5.5, 6.2], [-2.9, 8.3], [2.9, 8.3], [0, 8.8]];

export class TeamAI {
  constructor(game, team, diff) {
    this.g = game;
    this.t = team;
    this.d = diff;
    this.ids = game.teamPlayers(team);
    this.b = {};
    for (const i of this.ids) {
      this.b[i] = { think: 0, plan: null, pause: 0, contestArmed: false, lastAct: null, contestAt: 0, spot: -1, cut: null, holdT: 0, jumped: false };
    }
    this.mark = {};          // defender -> the attacker he guards
    this.spotT = 0;
    this.lastPass = null;
  }

  rnd(a, b) { return a + this.g.rng() * (b - a); }

  // ---------- steering ----------
  setMove(i, x, z, mag = 1, sprint = false) {
    const s = this.g.ps[i].intent;
    const l = Math.hypot(x, z);
    if (l < 0.05) { s.x = s.z = s.mag = 0; s.sprint = false; return; }
    s.x = (x / l) * mag; s.z = (z / l) * mag; s.mag = mag; s.sprint = sprint;
  }
  stop(i) { this.setMove(i, 0, 0); }
  // a pass goes on the run: keep heading the way he was, a touch slower
  carry(i, act) {
    const s = this.g.ps[i].intent;
    if (!act.carry) act.carry = { x: s.x, z: s.z };
    const c = act.carry;
    this.setMove(i, c.x, c.z, Math.hypot(c.x, c.z) * 0.7);
  }
  // ease: a short re-step glides rather than lunges
  moveTo(i, x, z, { sprint = false, arrive = 0.25, ease = false } = {}) {
    const me = this.g.players[i].pos;
    const dx = x - me.x, dz = z - me.z;
    const d = Math.hypot(dx, dz);
    if (d < arrive) { this.stop(i); return d; }
    const mag = clamp(d / 1.2, ease ? 0.12 : 0.35, 1);
    this.setMove(i, dx, dz, mag, sprint && d > 2);
    return d;
  }
  // move to a point given in team t's frame
  moveToF(i, t, fx, fz, opts) {
    const w = fromFrame(t, clamp(fx, -COURT.halfW + 0.4, COURT.halfW - 0.4), clamp(fz, 0.5, L - 0.5));
    return this.moveTo(i, w.x, w.z, opts);
  }
  F(i, t) { const p = this.g.players[i].pos; return toFrame(t, p.x, p.z); }

  // ---------- possession changes ----------
  onPossession(team) {
    if (team === this.t) { for (const i of this.ids) { this.b[i].spot = -1; this.b[i].cut = null; this.b[i].holdT = 0; } this.spotT = 0; }
    else this.assignMarks();
  }

  // man-to-man: the matchups with the least total running (all six ways tried)
  assignMarks() {
    const g = this.g, D = this.ids, A = g.teamPlayers(1 - this.t);
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let best = perms[0], bc = 1e9;
    for (const pm of perms) {
      let c = 0;
      for (let k = 0; k < 3; k++) c += g.players[D[k]].pos.distanceTo(g.players[A[pm[k]]].pos);
      if (c < bc) { bc = c; best = pm; }
    }
    for (let k = 0; k < 3; k++) this.mark[D[k]] = A[best[k]];
  }

  // two off-ball spots well away from the handler and from each other, near where they stand
  assignSpots(handler) {
    const g = this.g, t = this.t;
    const off = this.ids.filter((i) => i !== handler);
    const h = this.F(handler, t);
    let best = null, bs = -1e9;
    for (let a = 0; a < SPOTS.length; a++) {
      for (let c = 0; c < SPOTS.length; c++) {
        if (a === c) continue;
        const sa = SPOTS[a], sc = SPOTS[c];
        const dh = Math.min(Math.hypot(sa[0] - h.x, sa[1] - h.z), Math.hypot(sc[0] - h.x, sc[1] - h.z));
        const dd = Math.hypot(sa[0] - sc[0], sa[1] - sc[1]);
        const pa = this.F(off[0], t), pc = this.F(off[1], t);
        const travel = Math.hypot(sa[0] - pa.x, sa[1] - pa.z) + Math.hypot(sc[0] - pc.x, sc[1] - pc.z);
        const score = Math.min(dh, 7) * 1.2 + Math.min(dd, 9) * 0.6 - travel * 0.12 + this.rnd(0, 0.6);
        if (score > bs) { bs = score; best = [a, c]; }
      }
    }
    this.b[off[0]].spot = best[0];
    this.b[off[1]].spot = best[1];
    this.spotT = this.rnd(2.5, 4.5);
  }

  // ---------- per frame ----------
  update(dt) {
    const g = this.g;
    this.dt = dt;
    // someone on this team just passed: maybe give-and-go
    if (g.state === 'pass' && g.pass && g.pass.team === this.t && this.lastPass !== g.pass) {
      this.lastPass = g.pass;
      const br = this.b[g.pass.from];
      if (br && !g.pass.inbound && g.isAI(g.pass.from) && g.rng() < 0.4 + 0.3 * this.d.iq) br.cut = { until: g.t + 1.7, side: g.rng() < 0.5 ? -1 : 1 };
    }
    this.spotT -= dt;
    for (const i of this.ids) {
      if (!g.isAI(i)) continue;
      const br = this.b[i];
      br.think -= dt;
      this.step(i, dt, br);
    }
  }

  step(i, dt, br) {
    const g = this.g, st = g.state, me = g.players[i];
    if (st === 'over') { this.stop(i); return; }
    if (st === 'inbound') { this.inbound(i); return; }        // (the inbounder holds the ball in a locked pose)
    if (me.action && me.action.type === 'pass') { this.carry(i, me.action); return; }
    if (me.action && !['stumble', 'jab', 'celebrate', 'steal'].includes(me.action.type)) { this.stop(i); return; }
    if (st === 'tip') { this.tip(i, br); return; }
    if (st === 'dead') { this.deadBall(i); return; }
    const h = g.handler;
    if (h === i) { br.holdT += dt; this.handle(i, dt, br); return; }
    br.holdT = 0;
    if (h >= 0) { if (g.teamOf(h) === this.t) this.offBall(i, br); else this.defend(i, br); return; }
    if (st === 'pass' && g.pass) {
      if (g.pass.team === this.t) { if (g.pass.to === i) this.receive(i); else this.offBall(i, br); }
      else this.jumpLane(i, br);
      return;
    }
    if (st === 'shot') { this.rebound(i, br); return; }
    this.loose(i, br);
  }

  // ---------- tip-off ----------
  tip(i, br) {
    const g = this.g, b = g.ball, me = g.players[i];
    this.stop(i);
    if (!g.jumpers.includes(i) || g.tipped || !b.free) { br.jumped = false; return; }
    if (br.jumped) return;
    // jump so the hands peak as the falling ball gets to them
    const c = g.contestShape(i);
    const handY = 2.2 * me.s + c.jump;
    const vy = b.vel.y, y = b.pos.y - handY;
    if (vy > 1.2) return;
    const tHit = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * 9.81 * y))) / 9.81;
    const err = (1 - this.d.iq) * 0.18;
    if (br.tipAt === undefined) br.tipAt = c.peak + this.rnd(-err, err);
    if (tHit <= br.tipAt) { br.jumped = true; br.tipAt = undefined; g.cmdContest(i); }
  }

  // ---------- dead ball: walk to the inbound, or get back ----------
  deadBall(i) {
    const g = this.g, pd = g.pending;
    if (!pd || !pd.spot) { this.stop(i); return; }
    if (pd.team === this.t) {
      if (g.pendingBy === i) { this.moveTo(i, pd.spot.x, pd.spot.z, { sprint: true, arrive: 0.3 }); return; }
      // the others start up the floor from their own end
      const k = this.ids.filter((j) => j !== g.pendingBy).indexOf(i);
      const sf = toFrame(this.t, pd.spot.x, pd.spot.z).z;
      this.moveToF(i, this.t, k === 0 ? -4.2 : 4.6, clamp(sf - (k === 0 ? 6.5 : 10), 5, L - 6), { sprint: false });
    } else this.getBack(i);
  }

  // defenders retreat toward their own basket and pick up their man there
  getBack(i) {
    const g = this.g, A = 1 - this.t;
    const m = this.mark[i] !== undefined ? this.mark[i] : g.teamPlayers(A)[this.ids.indexOf(i)];
    const mf = this.F(m, A);
    this.moveToF(i, A, mf.x * 0.6, clamp(mf.z - 2.5, 4.5, 11.5), { sprint: true, arrive: 0.4 });
  }

  inbound(i) {
    const g = this.g, inb = g.inb;
    if (!inb) { this.stop(i); return; }
    if (inb.team !== this.t) { this.getBack(i); return; }
    if (inb.by === i) {
      // the inbounder: in to the receiver once he's come to the ball and it's safe (or to the other man, if he's freer)
      if (!inb.passing && !g.isUser(inb.to) && inb.t > 0.5) {
        const alt = g.mates(i).find((j) => j !== inb.to);
        if (alt !== undefined && g.laneRisk(i, alt) + 0.25 < g.laneRisk(i, inb.to)) inb.to = alt;
      }
      const q = g.players[inb.to].pos;
      const d = Math.hypot(q.x - inb.spot.x, q.z - inb.spot.z);
      const wait = g.isUser(inb.to) ? 0.95 : 0.75;
      const risk = g.laneRisk(i, inb.to);
      if (!inb.passing && inb.t > wait && (d < 7.5 || inb.t > 1.6) && (risk < 0.5 || inb.t > 2.0)) g.cmdPass(i, inb.to, { lob: risk >= 0.5 });
      this.stop(i);
      return;
    }
    if (inb.to === i) {
      // come to the ball, away from the nearest defender
      const n = g.nearestOpp(i);
      const me = g.players[i].pos, q = n.j >= 0 ? g.players[n.j].pos : me;
      const side = n.j >= 0 ? Math.sign(inb.into.x === 0 ? me.x - q.x : me.z - q.z) || 1 : 1;
      const deep = n.d < 2 ? 5.5 : 3.2;          // covered: get further up the floor
      const tx = inb.spot.x + inb.into.x * deep + (inb.into.x === 0 ? side * 1.8 : 0);
      const tz = inb.spot.z + inb.into.z * deep + (inb.into.z === 0 ? side * 1.8 : 0);
      this.moveTo(i, clamp(tx, -COURT.halfW + 0.5, COURT.halfW - 0.5), clamp(tz, 0.6, L - 0.6), { sprint: true, arrive: 0.3 });
      return;
    }
    const f = this.F(inb.by, this.t);
    this.moveToF(i, this.t, f.x > 0 ? -4.5 : 4.5, clamp(f.z - 6, 9, L - 5), { sprint: true });
  }

  // ---------- the ball handler (CPU only) ----------
  handle(i, dt, br) {
    const g = this.g, me = g.players[i], s = g.ps[i], r = s.r, t = this.t;
    if (g.state !== 'live' || me.action) { this.stop(i); return; }
    if (br.pause > 0) { br.pause -= dt; this.stop(i); return; }
    const R = g.rimOf(i);
    const dRim = Math.hypot(me.pos.x - R.x, me.pos.z - R.z) || 1;
    const tx = (R.x - me.pos.x) / dRim, tz = (R.z - me.pos.z) / dRim;
    const n = g.nearestOpp(i);
    const opp = g.players[n.j];
    const ox = opp.pos.x - me.pos.x, oz = opp.pos.z - me.pos.z;
    const dOpp = n.d;
    const inFront = dOpp > 0 ? (ox * tx + oz * tz) / dOpp : 0;   // 1 = defender between me and the rim
    const f = this.F(i, t);
    // how many defenders are between me and the basket
    let ahead = 0;
    for (const j of g.opps(i)) { const q = this.F(j, t); if (q.z < f.z - 0.3 && Math.abs(q.x - f.x) < 4.5) ahead++; }

    if (br.think <= 0) {
      br.think = this.rnd(0.16, 0.3) * (1.4 - this.d.iq * 0.6);
      const clock = g.shotClock;
      const desperate = clock < 2.2 || (g.clock < 2.4 && !g.overtime && g.score[t] <= g.score[1 - t]);
      // a teammate open enough to be worth more than my shot
      const est = g.jumperProb(i, 'good', true);
      let bestJ = -1, bestV = -1;
      for (const j of g.mates(i)) {
        const v = g.openness(j) - g.laneRisk(i, j) * 0.8;
        if (v > bestV) { bestV = v; bestJ = j; }
      }
      // up the floor: push it, or hit the man ahead
      if (f.z > COURT.halfLen - 1) {
        if (bestJ >= 0 && this.F(bestJ, t).z < f.z - 6 && bestV > 0.45 && g.rng() < 0.5) { g.cmdPass(i, bestJ); return; }
        br.plan = { x: clamp(f.x * 0.5, -4, 4), z: 7.5, sprint: dOpp > 2.2 || ahead === 0, until: g.t + 0.8, frame: true };
      } else {
        // finishing chance
        if (dRim < 1.6 || (dRim < 3.2 && (inFront < 0.4 || dOpp > 1.6) && me.vel.x * tx + me.vel.z * tz > 1.3)) { g.cmdShoot(i); return; }
        const three = g.threeAt(i, me.pos.x, me.pos.z);
        const want = (three ? 0.32 : 0.38) - this.d.iq * 0.06 + this.rnd(-0.05, 0.05);
        if ((est > want && dOpp > 1.25 && dRim < 8.3) || (desperate && dRim > 2.5 && (bestV < est + 0.1 || clock < 1.2))) { this.shoot(i); return; }
        // the extra pass
        const held = br.holdT > 0.6;
        if (bestJ >= 0 && held && bestV > est + 0.12 && g.rng() < 0.45 + 0.4 * this.d.iq) { g.cmdPass(i, bestJ); return; }
        if (bestJ >= 0 && dOpp < 0.95 && bestV > 0.32 && g.rng() < 0.35) { g.cmdPass(i, bestJ); return; }
        if (desperate && bestJ >= 0 && bestV > est + 0.05) { g.cmdPass(i, bestJ); return; }
        // fast break: nobody back, take it all the way
        if (ahead === 0 && dRim > 2) { br.plan = { x: R.x, z: R.z, sprint: true, until: g.t + 0.7 }; }
        else if (dOpp < 1.5 && s.moveCd <= 0 && g.rng() < 0.3 + 0.3 * (r.handle / 100)) {
          // dribble moves when pressured
          const roll = g.rng();
          const perpX = -tz, perpZ = tx;
          if (roll < 0.25 && r.three > 75 && dRim < 8.2) g.cmdMove(i, -tx, -tz);          // step-back
          else if (roll < 0.45 && inFront > 0.5) g.cmdMove(i, tx, tz);                     // spin
          else { const sd = g.rng() < 0.5 ? 1 : -1; g.cmdMove(i, perpX * sd, perpZ * sd); }
          return;
        } else if (g.rng() < 0.12) {
          // hesitation now and then
          if (g.rng() < 0.5 && dOpp < 2.4) g.cmdJab(i, g.rng() < 0.5 ? 1 : -1);
          br.pause = this.rnd(0.3, 0.6);
          return;
        } else {
          const style = r.finish + r.dunk * 0.5 > r.three + r.mid * 0.5 ? 'inside' : 'outside';
          if (inFront > 0.55 && dOpp < 1.8) {
            // go around: attack the side away from the defender's lean
            const perpX = -tz, perpZ = tx;
            const side = (ox * perpX + oz * perpZ) > 0 ? -1 : 1;
            br.plan = { x: me.pos.x + perpX * side * 1.6 + tx * 1.2, z: me.pos.z + perpZ * side * 1.6 + tz * 1.2, sprint: g.rng() < 0.5, until: g.t + 0.6 };
          } else if (style === 'outside' && !three && g.rng() < 0.4) {
            const sp = SPOTS[Math.floor(g.rng() * SPOTS.length)];
            br.plan = { x: sp[0], z: sp[1], sprint: false, until: g.t + 1.2, frame: true };
          } else {
            br.plan = { x: R.x + this.rnd(-0.6, 0.6), z: R.z + 1.2 * g.basketOf(i).dir, sprint: dOpp > 1.2 || inFront < 0.3, until: g.t + 0.7 };
          }
        }
      }
    }
    if (br.plan) {
      const p = br.plan;
      const d = p.frame ? this.moveToF(i, t, p.x, p.z, { sprint: p.sprint }) : this.moveTo(i, p.x, p.z, { sprint: p.sprint });
      if (d < 0.3 || g.t > p.until) br.plan = null;
    } else this.stop(i);
  }

  shoot(i) {
    const g = this.g;
    this.stop(i);
    g.startJumper(i);
    const act = g.players[i].action;
    const rating = act.three ? g.ps[i].r.three : g.ps[i].r.mid;
    // release timing noise shrinks with skill and difficulty
    const sd = (0.1 - 0.06 * (rating / 100)) / this.d.shot;
    const apexT = 0.2 + 0.62 * 0.5;
    act.aiRelease = clamp(apexT + gauss(g.rng) * sd * 0.74, 0.22, 0.74);
  }

  // ---------- offence without the ball ----------
  offBall(i, br) {
    const g = this.g, t = this.t, h = g.handler;
    const f = this.F(i, t);
    const hb = h >= 0 ? h : (g.pass ? g.pass.to : -1);
    const hf = hb >= 0 ? this.F(hb, t) : { x: 0, z: 10 };
    // a teammate's shot going up: crash the glass or get back
    if (h >= 0 && g.players[h].action && ['shoot', 'layup', 'dunk'].includes(g.players[h].action.type)) {
      const others = this.ids.filter((j) => j !== h);
      const nearest = others.reduce((a, c) => (this.F(a, t).z < this.F(c, t).z ? a : c));
      if (i === nearest) this.moveToF(i, t, f.x > 0 ? 1.3 : -1.3, 2.6, { sprint: true });
      else this.moveToF(i, t, f.x * 0.5, 11, {});
      return;
    }
    // transition: the ball is still in the back court, run the lanes
    if (hf.z > COURT.halfLen - 1) {
      const k = this.ids.filter((j) => j !== hb).indexOf(i);
      if (k === 0) this.moveToF(i, t, hf.x > 0 ? -2.6 : 2.6, 3.8, { sprint: true });       // rim runner
      else this.moveToF(i, t, hf.x > 0 ? 5.6 : -5.6, 6.5, { sprint: true });               // wing
      return;
    }
    // a cut in progress (give-and-go or backdoor)
    if (br.cut && g.t < br.cut.until) {
      this.moveToF(i, t, br.cut.side * 0.9, 2.1, { sprint: true, arrive: 0.3 });
      return;
    }
    br.cut = null;
    if (hb >= 0 && (br.spot < 0 || (h >= 0 && this.spotT <= 0))) this.assignSpots(hb);
    if (br.spot < 0) { this.stop(i); return; }
    const sp = SPOTS[br.spot];
    // the handler drives at me: clear out
    const dh = Math.hypot(hf.x - f.x, hf.z - f.z);
    let sx = sp[0], sz = sp[1];
    if (dh < 3) { sx = clamp(f.x + (f.x - hf.x) * 0.8, -6.8, 6.8); sz = clamp(f.z + (f.z - hf.z) * 0.8, 1.2, 9.5); }
    this.moveToF(i, t, sx, sz, { sprint: Math.hypot(sx - f.x, sz - f.z) > 4, arrive: 0.35 });
    // backdoor: my man is overplaying or watching the ball
    if (br.think <= 0) {
      br.think = this.rnd(0.4, 0.8);
      const n = g.nearestOpp(i);
      if (n.j >= 0 && h >= 0 && f.z < 9.5 && Math.abs(f.x) > 3) {
        const q = this.F(n.j, t);
        const denying = q.z > f.z + 0.4 && n.d < 1.6;                 // he's up on me, toward the ball
        const sleeping = n.d > 3.2;
        if ((denying || sleeping) && g.rng() < 0.12 + 0.2 * this.d.iq) br.cut = { until: g.t + 1.5, side: Math.sign(f.x) * 0.6 };
      }
    }
  }

  // the pass is coming to me: go and meet it
  receive(i) {
    const g = this.g, ps = g.pass;
    this.moveTo(i, ps.aim.x, ps.aim.z, { sprint: true, arrive: 0.15 });
  }

  // ---------- defence ----------
  defend(i, br) {
    const g = this.g, me = g.players[i], s = g.ps[i], A = 1 - this.t;
    if (s.off > 0) { this.stop(i); return; }
    if (this.mark[i] === undefined) this.assignMarks();
    const m = this.mark[i];
    const h = g.handler;
    const hp = g.players[h];
    const hAct = hp.action;
    // a shot or drive going up near me: contest it
    if (hAct && ['shoot', 'layup', 'dunk'].includes(hAct.type)) {
      const d = Math.hypot(hp.pos.x - me.pos.x, hp.pos.z - me.pos.z);
      if (br.lastAct !== hAct) {
        br.lastAct = hAct;
        const near = m === h ? 1 : clamp((3 - d) / 2, 0, 1);
        br.contestArmed = g.rng() < this.d.contest * near;
        br.contestAt = this.d.react * this.rnd(0.6, 1.1) + (hAct.type === 'shoot' ? this.rnd(0.05, 0.2) : 0);
      }
      if (br.contestArmed && hAct.t >= br.contestAt && d < 2.3) { br.contestArmed = false; g.cmdContest(i); return; }
      if (m === h || d < 3) {
        const R = g.rimOf(h);
        this.moveTo(i, hp.pos.x + (R.x - hp.pos.x) * 0.1, hp.pos.z + (R.z - hp.pos.z) * 0.1, { sprint: true, arrive: 0.5 });
        return;
      }
    }
    if (m === h) { this.onBall(i, br); return; }
    // off the ball: between my man and the basket, sagging toward the ball; help on a drive
    const mf = this.F(m, A), hf = this.F(h, A), f = this.F(i, A);
    const dHelp = Math.hypot(hf.x, hf.z - RZ);
    const onBallD = Object.keys(this.mark).find((k) => this.mark[k] === h);
    const beaten = onBallD !== undefined && this.F(+onBallD, A).z > hf.z + 0.3;
    if (dHelp < 4.8 && beaten && this.helper(h) === i) {
      // step into the lane in front of the driver
      const k = 1.1 / Math.max(1.1, dHelp);
      this.moveToF(i, A, hf.x - hf.x * k, hf.z - (hf.z - RZ) * k, { sprint: true, arrive: 0.1 });
      return;
    }
    const dmb = Math.hypot(mf.x - hf.x, mf.z - hf.z);
    const sag = clamp(0.18 + dmb * 0.035, 0.18, 0.5);
    let tx = mf.x + (0 - mf.x) * sag + (hf.x - mf.x) * 0.15;
    let tz = mf.z + (RZ - mf.z) * sag + (hf.z - mf.z) * 0.15;
    // the ball is up the floor: don't follow a man into the back court
    if (hf.z > COURT.halfLen + 2) tz = Math.min(tz, COURT.halfLen + 1);
    const far = Math.hypot(tx - f.x, tz - f.z);
    this.moveToF(i, A, tx, tz, { sprint: far > 2, arrive: 0.25 });
  }

  // the off-ball defender nearest the driver's path
  helper(h) {
    const g = this.g;
    let best = -1, bd = 1e9;
    for (const j of this.ids) {
      if (this.mark[j] === h || !g.isAI(j)) continue;
      const d = g.players[j].pos.distanceTo(g.players[h].pos);
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }

  // on the ball: a lagged read of the handler, between him and the basket
  onBall(i, br) {
    const g = this.g, me = g.players[i], h = g.handler, opp = g.players[h];
    const R = g.rimOf(h);
    const lagT = g.t - this.d.react;
    let hx = opp.pos.x, hz = opp.pos.z;
    const hist = g.ps[h].hist;
    for (let k = hist.length - 1; k >= 0; k--) { if (hist[k].t <= lagT) { hx = hist[k].x; hz = hist[k].z; break; } }
    const dRim = Math.hypot(hx - R.x, hz - R.z) || 1;
    // pick him up loosely in the back court, tighter as he gets close
    const gap = clamp(0.95 + (dRim - 3) * 0.08, 0.9, dRim > 15 ? 3.2 : 1.55);
    const ph = g.t * 1.3 + i * 2;
    const px = -(R.z - hz) / dRim, pz = (R.x - hx) / dRim;          // perpendicular to the drive line
    const stunt = 0.07 * Math.sin(ph * 0.8) + 0.03 * Math.sin(ph * 1.9);
    const gx = hx + (R.x - hx) / dRim * (gap + 0.04 * Math.sin(ph * 0.5)) + px * stunt;
    const gz = hz + (R.z - hz) / dRim * (gap + 0.04 * Math.sin(ph * 0.5)) + pz * stunt;
    // set: hold the spot while he's still; only re-step when he's really moved
    const still = Math.hypot(opp.vel.x, opp.vel.z) < 0.6;
    const d = Math.hypot(gx - me.pos.x, gz - me.pos.z);
    if (still && d < 0.32 && Math.hypot(me.vel.x, me.vel.z) < 0.4) this.stop(i);
    else this.moveTo(i, gx, gz, { sprint: d > 1.6, arrive: still ? 0.08 : 0.12, ease: true });
    // reach for the ball
    const dh = Math.hypot(opp.pos.x - me.pos.x, opp.pos.z - me.pos.z);
    if (dh < 1.15 && !me.action && g.rng() < this.dt * 0.55 * this.d.steal) g.cmdSteal(i);
  }

  // a pass in the air from the other team: jump the lane if it's coming past me, else pick up my man
  jumpLane(i, br) {
    const g = this.g, ps = g.pass, b = g.ball, me = g.players[i];
    const ax = ps.aim.x - b.pos.x, az = ps.aim.z - b.pos.z, al = Math.hypot(ax, az) || 1;
    const u = clamp(((me.pos.x - b.pos.x) * ax + (me.pos.z - b.pos.z) * az) / (al * al), 0, 1);
    const cx = b.pos.x + ax * u, cz = b.pos.z + az * u;
    const d = Math.hypot(cx - me.pos.x, cz - me.pos.z);
    if (d < 2.2 * (0.6 + 0.6 * this.d.iq) && u > 0.15) { this.moveTo(i, cx, cz, { sprint: true, arrive: 0.05 }); return; }
    const m = this.mark[i];
    if (m !== undefined) { const q = g.players[m].pos; const R = g.rimOf(m); this.moveTo(i, q.x + (R.x - q.x) * 0.15, q.z + (R.z - q.z) * 0.15, { sprint: true }); }
    else this.stop(i);
  }

  // ---------- rebounds and loose balls ----------
  rebound(i, br) {
    const g = this.g, sh = g.shot;
    if (!sh) { this.loose(i, br); return; }
    const S = sh.team;                               // the shooting team's frame: its basket at (0, rimZ)
    const f = this.F(i, S);
    if (sh.shooter === i) { this.stop(i); return; }
    const toRim = (j) => { const q = this.F(j, S); return Math.hypot(q.x, q.z - RZ); };
    const order = this.ids.filter((j) => j !== sh.shooter).sort((a, c) => toRim(a) - toRim(c));
    const rank = order.indexOf(i);
    if (this.t === S) {
      // the shooting side: one crashes, the rest get back
      if (rank === 0) this.moveToF(i, S, f.x > 0 ? 1.6 : -1.6, 2.8, { sprint: true });
      else this.moveToF(i, S, f.x * 0.5, rank === 1 ? 9 : 13, { sprint: false });
    } else {
      // the defence: box out the nearest attacker, the far one leaks out a little
      if (rank < 2) {
        const m = this.mark[i] !== undefined ? this.mark[i] : -1;
        const q = m >= 0 ? this.F(m, S) : { x: f.x, z: 4 };
        const dq = Math.hypot(q.x, q.z - RZ) || 1;
        const k = Math.max(1.6, dq - 0.9) / dq;
        this.moveToF(i, S, q.x * k, RZ + (q.z - RZ) * k, { sprint: true, arrive: 0.2 });
      } else this.moveToF(i, S, f.x * 0.6, 8.5, {});
    }
  }

  loose(i, br) {
    const g = this.g, me = g.players[i], b = g.ball;
    if (me.action) { this.stop(i); return; }
    // predict where the ball comes down to ~1.8 m
    let px = b.pos.x, pz = b.pos.z;
    if (b.pos.y > 1.8) {
      const vy = b.vel.y, y = b.pos.y - 1.8;
      const t = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * 9.81 * y))) / 9.81;
      px += b.vel.x * t * 0.9; pz += b.vel.z * t * 0.9;
    }
    px = clamp(px, -COURT.halfW + 0.3, COURT.halfW - 0.3); pz = clamp(pz, 0.3, L - 0.3);
    // the two nearest on each side chase it; the third gets back
    const order = this.ids.slice().sort((a, c) => g.players[a].pos.distanceTo(b.pos) - g.players[c].pos.distanceTo(b.pos));
    if (order.indexOf(i) === 2) {
      const f = this.F(i, 1 - this.t);
      this.moveToF(i, 1 - this.t, f.x * 0.5, 7, {});
      return;
    }
    this.moveTo(i, px, pz, { sprint: true, arrive: 0.1 });
    const dxz = Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z);
    if (dxz < 1.0 && b.pos.y > 2.3 && b.pos.y < 3.4 && b.vel.y < 0 && g.rng() < 0.5 + this.d.iq * 0.4) g.cmdContest(i);
  }
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
