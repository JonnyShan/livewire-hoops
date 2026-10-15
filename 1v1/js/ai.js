// CPU opponent: reads the defender, picks shots, guards with human-like lag.
import { RIM, isThree, COURT } from './arena.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const rnd = (a, b) => a + Math.random() * (b - a);

export class AI {
  constructor(game, idx, diff) {
    this.g = game;
    this.i = idx;
    this.d = diff;
    this.think = 0;
    this.plan = null;          // { x, z, sprint, until }
    this.pause = 0;
    this.contestArmed = false;
    this.lastShooterAct = null;
  }

  get me() { return this.g.players[this.i]; }
  get opp() { return this.g.players[1 - this.i]; }
  get s() { return this.g.ps[this.i]; }

  setMove(x, z, mag = 1, sprint = false) {
    const l = Math.hypot(x, z);
    const s = this.s.intent;
    if (l < 0.05) { s.x = s.z = s.mag = 0; s.sprint = false; return; }
    s.x = (x / l) * mag; s.z = (z / l) * mag; s.mag = mag; s.sprint = sprint;
  }

  moveTo(x, z, { sprint = false, arrive = 0.25 } = {}) {
    const me = this.me;
    const dx = x - me.pos.x, dz = z - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < arrive) { this.setMove(0, 0); return d; }
    const mag = clamp(d / 1.2, 0.35, 1);
    this.setMove(dx, dz, mag, sprint && d > 2);
    return d;
  }

  update(dt) {
    const g = this.g;
    this.think -= dt;
    const st = g.state;
    if (st === 'check' || st === 'checkpass' || st === 'dead') { this.setMove(0, 0); this.contestArmed = false; return; }
    if (g.handler === this.i) this.offense(dt);
    else if (g.handler === 1 - this.i) this.defense(dt);
    else this.loose(dt);
  }

  // ---------------- offense ----------------
  offense(dt) {
    const g = this.g, me = this.me, opp = this.opp, s = this.s;
    if (g.state !== 'live' || me.action) { this.setMove(0, 0); return; }
    const dRim = Math.hypot(me.pos.x - RIM.x, me.pos.z - RIM.z);
    const tx = (RIM.x - me.pos.x) / dRim, tz = (RIM.z - me.pos.z) / dRim;
    const ox = opp.pos.x - me.pos.x, oz = opp.pos.z - me.pos.z;
    const dOpp = Math.hypot(ox, oz);
    const inFront = dOpp > 0 ? (ox * tx + oz * tz) / dOpp : 0;   // 1 = defender between me and rim
    const r = s.r;

    if (g.needClear) {
      // take it back out past the arc along the line from the rim
      const ax = me.pos.x - RIM.x, az = me.pos.z - RIM.z, al = Math.hypot(ax, az) || 1;
      let cx = RIM.x + (ax / al) * 8.0, cz = RIM.z + (az / al) * 8.0;
      if (cz < 5) { cz = 8.5; cx = clamp(cx, -5, 5); }
      this.moveTo(cx, cz, { sprint: false, arrive: 0.2 });
      return;
    }

    if (this.pause > 0) { this.pause -= dt; this.setMove(0, 0); return; }

    if (this.think <= 0) {
      this.think = rnd(0.16, 0.3) * (1.4 - this.d.iq * 0.6);
      const clock = g.shotClock;
      const open = dOpp;
      // finishing chance
      if (dRim < 1.6 || (dRim < 3.0 && (inFront < 0.4 || open > 1.6) && me.vel.x * tx + me.vel.z * tz > 1.3)) {
        g.startFinish(this.i);
        return;
      }
      const est = g.jumperProb(this.i, 'good', true);
      const three = isThree(me.pos.x, me.pos.z);
      const want = (three ? 0.32 : 0.38) - this.d.iq * 0.06 + rnd(-0.05, 0.05);
      const desperate = clock < 2.2;
      if ((est > want && open > 1.25 && dRim < 8.3) || (desperate && dRim > 2.5)) {
        this.shoot();
        return;
      }
      if (desperate) { this.plan = { x: RIM.x, z: RIM.z + 1, sprint: true, until: g.t + 1 }; }
      // dribble moves when pressured
      if (dOpp < 1.5 && s.moveCd <= 0 && Math.random() < 0.3 + 0.3 * (r.handle / 100)) {
        const roll = Math.random();
        const perpX = -tz, perpZ = tx;
        if (roll < 0.25 && r.three > 75 && dRim < 8.2) g.doMove(this.i, -tx, -tz);          // step-back
        else if (roll < 0.45 && inFront > 0.5) g.doMove(this.i, tx, tz);                     // spin
        else { const sd = Math.random() < 0.5 ? 1 : -1; g.doMove(this.i, perpX * sd, perpZ * sd); }
        return;
      }
      // hesitation now and then
      if (Math.random() < 0.14) {
        const r = Math.random();
        if (r < 0.5 && dOpp < 2.4) g.jab(this.i, Math.random() < 0.5 ? 1 : -1);
        else if (r < 0.75 && s.moveCd <= 0) g.doMove(this.i, 0, 0);
        this.pause = rnd(0.35, 0.7);
        return;
      }
      // pick a drive / reposition target
      const style = r.finish + r.dunk * 0.5 > r.three + r.mid * 0.5 ? 'inside' : 'outside';
      if (inFront > 0.55 && dOpp < 1.8) {
        // go around: attack the side away from the defender's lean
        const perpX = -tz, perpZ = tx;
        const side = (ox * perpX + oz * perpZ) > 0 ? -1 : 1;
        this.plan = { x: me.pos.x + perpX * side * 1.6 + tx * 1.2, z: me.pos.z + perpZ * side * 1.6 + tz * 1.2, sprint: Math.random() < 0.5, until: g.t + 0.6 };
      } else if (style === 'outside' && !three && Math.random() < 0.4) {
        // relocate to a three-point spot
        const spots = [[0, 9.0], [-5.2, 6.8], [5.2, 6.8], [-6.9, 1.8], [6.9, 1.8], [-3.8, 8.3], [3.8, 8.3]];
        const sp = spots[Math.floor(Math.random() * spots.length)];
        this.plan = { x: sp[0], z: sp[1], sprint: false, until: g.t + 1.2 };
      } else {
        this.plan = { x: RIM.x + rnd(-0.6, 0.6), z: RIM.z + 1.2, sprint: dOpp > 1.2 || inFront < 0.3, until: g.t + 0.7 };
      }
    }
    if (this.plan) {
      const d = this.moveTo(this.plan.x, clamp(this.plan.z, 0.6, 13.5), { sprint: this.plan.sprint });
      if (d < 0.3 || g.t > this.plan.until) this.plan = null;
    } else this.setMove(0, 0);
  }

  shoot() {
    const g = this.g;
    this.setMove(0, 0);
    g.startJumper(this.i);
    const act = this.me.action;
    const rating = act.three ? this.s.r.three : this.s.r.mid;
    // release timing noise shrinks with skill and difficulty
    const sd = (0.1 - 0.06 * (rating / 100)) / this.d.shot;
    const apexT = 0.2 + 0.62 * 0.5;
    act.aiRelease = clamp(apexT + gauss() * sd * 0.74, 0.22, 0.74);
  }

  // ---------------- defense ----------------
  defense(dt) {
    const g = this.g, me = this.me, opp = this.opp, s = this.s;
    if (me.action && me.action.type !== 'stumble') { this.setMove(0, 0); return; }
    if (s.off > 0) { this.setMove(0, 0); return; }
    const oppAct = opp.action;
    // react to a shot / drive
    if (oppAct && ['shoot', 'layup', 'dunk'].includes(oppAct.type)) {
      if (this.lastShooterAct !== oppAct) {
        this.lastShooterAct = oppAct;
        this.contestArmed = Math.random() < this.d.contest;
        this.contestAt = this.d.react * rnd(0.6, 1.1) + (oppAct.type === 'shoot' ? rnd(0.05, 0.2) : 0);
      }
      const d = Math.hypot(opp.pos.x - me.pos.x, opp.pos.z - me.pos.z);
      if (this.contestArmed && oppAct.t >= this.contestAt && d < 2.3) {
        this.contestArmed = false;
        g.contest(this.i);
        return;
      }
      // close out
      this.moveTo(opp.pos.x + (RIM.x - opp.pos.x) * 0.1, opp.pos.z + (RIM.z - opp.pos.z) * 0.1, { sprint: true, arrive: 0.5 });
      return;
    }
    // lagged read of the handler
    const lagT = g.t - this.d.react;
    let hx = opp.pos.x, hz = opp.pos.z;
    const hist = g.ps[1 - this.i].hist;
    for (let k = hist.length - 1; k >= 0; k--) { if (hist[k].t <= lagT) { hx = hist[k].x; hz = hist[k].z; break; } }
    const dRim = Math.hypot(hx - RIM.x, hz - RIM.z) || 1;
    const gap = clamp(0.95 + (dRim - 3) * 0.08, 0.9, 1.55) * (g.needClear ? 1.4 : 1);
    const ph = g.t * 1.3 + this.i * 2;
    const px = -(RIM.z - hz) / dRim, pz = (RIM.x - hx) / dRim;          // perpendicular to the drive line
    const stunt = 0.16 * Math.sin(ph) + 0.08 * Math.sin(ph * 2.7);
    const gx = hx + (RIM.x - hx) / dRim * (gap + 0.1 * Math.sin(ph * 0.7)) + px * stunt;
    const gz = hz + (RIM.z - hz) / dRim * (gap + 0.1 * Math.sin(ph * 0.7)) + pz * stunt;
    const d = this.moveTo(gx, gz, { sprint: Math.hypot(gx - me.pos.x, gz - me.pos.z) > 1.6, arrive: 0.12 });
    // reach for the ball
    const dh = Math.hypot(opp.pos.x - me.pos.x, opp.pos.z - me.pos.z);
    if (dh < 1.15 && !me.action && Math.random() < dt * 0.55 * this.d.steal) g.trySteal(this.i);
    return d;
  }

  // ---------------- loose ball ----------------
  loose(dt) {
    const g = this.g, me = this.me, b = g.ball;
    if (me.action) { this.setMove(0, 0); return; }
    // predict where the ball comes down to ~1.8 m
    let px = b.pos.x, pz = b.pos.z;
    if (b.pos.y > 1.8) {
      const vy = b.vel.y, y = b.pos.y - 1.8;
      const t = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * 9.81 * y))) / 9.81;
      px += b.vel.x * t * 0.9; pz += b.vel.z * t * 0.9;
    }
    px = clamp(px, -7.3, 7.3); pz = clamp(pz, 0.3, 13.8);
    const dx = b.pos.x - me.pos.x, dz = b.pos.z - me.pos.z;
    const dxz = Math.hypot(dx, dz);
    this.moveTo(px, pz, { sprint: true, arrive: 0.1 });
    if (dxz < 1.0 && b.pos.y > 2.3 && b.pos.y < 3.4 && b.vel.y < 0 && Math.random() < 0.5 + this.d.iq * 0.4) g.contest(this.i);
  }
}

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
