// Highlight replays. Every frame the last few seconds of play are recorded:
// the players' bones, their shadows and loose kit, the ball and the net, plus
// the ball sounds and a light track of where everyone is. After your threes and
// dunks a director cuts the play together like a broadcast: three angles, each
// one picked so nobody stands in the way, with speed ramps into super slow
// motion at the moment that matters, a name strip, a tracer on a three's
// flight, and camera flashes on a slam. A branded video clip (with the crowd
// audio) is recorded for sharing.
import * as THREE from 'three';
import { RIM, COURT } from './arena.js';
import { BRAND } from './data.js';

const KEEP = 7;          // seconds of play kept
const MAXF = 720;        // frame slots (KEEP s at up to ~100 fps)
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const SOUNDS = ['dribble', 'rim', 'board', 'swish', 'dunk'];
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const TRACE_N = 96;      // tracer points
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _q2 = new THREE.Vector3(), _r = new THREE.Vector3(), _s = new THREE.Vector3();

export class Replay {
  constructor({ renderer, camera, sound, canvas }) {
    this.renderer = renderer; this.camera = camera; this.sound = sound; this.canvas = canvas;
    this.pending = null;
    this.active = false;
    this.clip = null;          // the latest recorded clip { blob, name }
    this.onDone = null;
    this.events = [];          // ball sounds: { t, name, args }
  }

  // ---------- setup ----------
  bind({ players, ball, net, game, renderer, arena }) {
    if (renderer) this.renderer = renderer;
    this.players = players; this.ball = ball; this.net = net; this.game = game; this.arena = arena;
    // per player: everything that moves and is visible (the hidden driver rig is skipped)
    this.nodes = players.map((p) => {
      const skip = new Set();
      if (p.skin) p.root.traverse((o) => skip.add(o));
      const list = [];
      p.group.traverse((o) => { if (!skip.has(o)) list.push(o); });
      return list;
    });
    let n = 1;
    for (const list of this.nodes) n += list.length * 10 + 5 + 7;
    n += 14 + net.p.length * 3;
    this.F = n;
    this.buf = Array.from({ length: MAXF }, () => new Float32Array(n));
    this.times = new Float64Array(MAXF);
    this.states = new Array(MAXF);
    // where everyone is (x, jump height, z, facing) and the ball: what the director plans with
    this.TK = players.length * 4 + 3;
    this.trk = new Float32Array(MAXF * this.TK);
    this.trkOut = { p: players.map(() => ({ x: 0, y: 0, z: 0, yaw: 0 })), b: V() };
    this.head = 0; this.count = 0;
    this.events = [];
    this.makeTracer();
    // log ball sounds as they happen so the replay can play them again
    if (!this.sound.__replayWrapped) {
      this.sound.__replayWrapped = true;
      for (const name of SOUNDS) {
        const orig = this.sound[name].bind(this.sound);
        this.sound[name] = (...args) => {
          if (!this.active && this.game) this.events.push({ t: this.game.t, name, args });
          return orig(...args);
        };
      }
    }
  }

  // ---------- recording ----------
  record() {
    if (!this.buf || this.active) return;
    const g = this.game;
    // at most ~120 frames a second of real time (a faster screen would shorten the tape), counted in
    // game time scaled by the slow motion so a slowed-down slam keeps every frame
    if (this.count && g.t - this.times[this.idx(this.count - 1)] < 0.9 * (g.timeScale || 1) / 120) return;
    const k = this.head;
    const d = this.buf[k];
    let o = 0;
    d[o++] = g.t;
    this.players.forEach((p, i) => {
      for (const n of this.nodes[i]) {
        d[o++] = n.position.x; d[o++] = n.position.y; d[o++] = n.position.z;
        d[o++] = n.quaternion.x; d[o++] = n.quaternion.y; d[o++] = n.quaternion.z; d[o++] = n.quaternion.w;
        d[o++] = n.scale.x; d[o++] = n.scale.y; d[o++] = n.scale.z;
      }
      d[o++] = p.blob.material.opacity;
      for (const f of p.footShadow) { d[o++] = f.material.opacity; d[o++] = f.visible ? 1 : 0; }
      const c = p.cloth;
      if (c) {
        const s = c.u.uSway.value, fl = c.u.uFlutter.value;
        d[o++] = s.x; d[o++] = s.y; d[o++] = s.z; d[o++] = fl.x; d[o++] = fl.y; d[o++] = fl.z; d[o++] = fl.w;
      } else o += 7;
    });
    const b = this.ball;
    d[o++] = b.mesh.position.x; d[o++] = b.mesh.position.y; d[o++] = b.mesh.position.z;
    d[o++] = b.mesh.quaternion.x; d[o++] = b.mesh.quaternion.y; d[o++] = b.mesh.quaternion.z; d[o++] = b.mesh.quaternion.w;
    d[o++] = b.blob.position.x; d[o++] = b.blob.position.y; d[o++] = b.blob.position.z;
    d[o++] = b.blob.scale.x; d[o++] = b.blob.scale.y; d[o++] = b.blob.scale.z; d[o++] = b.blob.material.opacity;
    for (const v of this.net.p) { d[o++] = v.x; d[o++] = v.y; d[o++] = v.z; }
    const T = this.trk, tb = k * this.TK;
    this.players.forEach((p, i) => { T[tb + i * 4] = p.pos.x; T[tb + i * 4 + 1] = p.jumpY; T[tb + i * 4 + 2] = p.pos.z; T[tb + i * 4 + 3] = p.yaw; });
    const bo = tb + this.players.length * 4;
    T[bo] = b.mesh.position.x; T[bo + 1] = b.mesh.position.y; T[bo + 2] = b.mesh.position.z;
    this.times[k] = g.t;
    this.states[k] = g.state;
    this.head = (k + 1) % MAXF;
    this.count = Math.min(MAXF, this.count + 1);
    // forget sounds older than the buffer
    const t0 = g.t - KEEP;
    while (this.events.length && this.events[0].t < t0) this.events.shift();
  }

  // ring index of the i-th oldest frame
  idx(i) { return (this.head - this.count + i + MAXF) % MAXF; }

  // the two recorded frames around time t, and how far between them
  frameAt(t) {
    let lo = 0, hi = this.count - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.times[this.idx(m)] <= t) lo = m; else hi = m - 1; }
    const ia = this.idx(lo), ib = this.idx(Math.min(this.count - 1, lo + 1));
    const ta = this.times[ia], tb = this.times[ib];
    return { ia, ib, u: tb > ta ? clamp((t - ta) / (tb - ta), 0, 1) : 0 };
  }

  // where everyone and the ball were at time t, without touching the scene
  trackAt(t) {
    const { ia, ib, u } = this.frameAt(t);
    const T = this.trk, a = ia * this.TK, b = ib * this.TK, out = this.trkOut;
    out.p.forEach((q, i) => {
      const o = i * 4;
      q.x = T[a + o] + (T[b + o] - T[a + o]) * u;
      q.y = T[a + o + 1] + (T[b + o + 1] - T[a + o + 1]) * u;
      q.z = T[a + o + 2] + (T[b + o + 2] - T[a + o + 2]) * u;
      const dy = Math.atan2(Math.sin(T[b + o + 3] - T[a + o + 3]), Math.cos(T[b + o + 3] - T[a + o + 3]));
      q.yaw = T[a + o + 3] + dy * u;
    });
    const bo = this.players.length * 4;
    out.b.set(T[a + bo] + (T[b + bo] - T[a + bo]) * u, T[a + bo + 1] + (T[b + bo + 1] - T[a + bo + 1]) * u, T[a + bo + 2] + (T[b + bo + 2] - T[a + bo + 2]) * u);
    return out;
  }

  // apply the recorded state at time t (interpolated between frames)
  apply(t) {
    const { ia, ib, u } = this.frameAt(t);
    const A = this.buf[ia], B = this.buf[ib];
    const L = (j) => A[j] + (B[j] - A[j]) * u;
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    let o = 1;
    this.players.forEach((p, i) => {
      for (const n of this.nodes[i]) {
        n.position.set(L(o), L(o + 1), L(o + 2));
        qa.set(A[o + 3], A[o + 4], A[o + 5], A[o + 6]); qb.set(B[o + 3], B[o + 4], B[o + 5], B[o + 6]);
        n.quaternion.slerpQuaternions(qa, qb, u);
        n.scale.set(L(o + 7), L(o + 8), L(o + 9));
        o += 10;
      }
      p.blob.material.opacity = L(o++);
      for (const f of p.footShadow) { f.material.opacity = L(o++); f.visible = A[o++] > 0.5; }
      const c = p.cloth;
      if (c) {
        c.u.uSway.value.set(L(o), L(o + 1), L(o + 2));
        c.u.uFlutter.value.set(L(o + 3), L(o + 4), L(o + 5), L(o + 6));
      }
      o += 7;
      if (p.updateCull) p.updateCull();
    });
    const b = this.ball;
    b.mesh.position.set(L(o), L(o + 1), L(o + 2));
    qa.set(A[o + 3], A[o + 4], A[o + 5], A[o + 6]); qb.set(B[o + 3], B[o + 4], B[o + 5], B[o + 6]);
    b.mesh.quaternion.slerpQuaternions(qa, qb, u);
    o += 7;
    b.blob.position.set(L(o), L(o + 1), L(o + 2)); b.blob.scale.set(L(o + 3), L(o + 4), L(o + 5)); b.blob.material.opacity = L(o + 6);
    o += 7;
    for (const v of this.net.p) { v.set(L(o), L(o + 1), L(o + 2)); o += 3; }
    this.net.writeBuf();
    const attr = this.net.geo.attributes.instanceStart;
    attr.data.array.set(this.net.buf);
    attr.data.needsUpdate = true;
    return { ball: b.mesh.position };
  }

  // ---------- highlights ----------
  // called when you score a three or a dunk
  highlight(info) {
    if (!this.buf || this.count < 10) return;
    this.pending = { ...info, wait: 0 };
  }

  // seconds of real time after the basket before the replay rolls (a slam runs on in
  // slow motion and hangs on the rim: wait long enough to have the hang on tape)
  tickPending(realDt) {
    if (!this.pending) return false;
    this.pending.wait += realDt;
    return this.pending.wait > (this.pending.type === 'dunk' ? 2.1 : 1.25);
  }

  start() {
    const h = this.pending; this.pending = null;
    // the play's beats, from the recorded states: gather (shooting / finishing) and release
    let tShot = h.tMake - 2.5, tRelease = h.tMake - 1;
    for (let i = this.count - 1; i > 0; i--) {
      const s = this.states[this.idx(i)], prev = this.states[this.idx(i - 1)];
      const t = this.times[this.idx(i)];
      if (t > h.tMake) continue;
      if (s === 'shot' && prev !== 'shot') tRelease = t;
      if ((s === 'shooting' || s === 'finishing') && prev !== s) { tShot = t; break; }
    }
    const first = this.times[this.idx(0)];
    // the tape ends where the players are put back for the inbound (they jump to their places)
    let last = this.times[this.idx(this.count - 1)];
    for (let i = 0; i < this.count; i++) {
      const t = this.times[this.idx(i)];
      if (t > h.tMake && this.states[this.idx(i)] === 'inbound') { last = Math.max(h.tMake + 0.1, t - 0.05); break; }
    }
    const ctx = { h, m: h.tMake, tShot, tRelease, first, last, who: h.shooter, s: this.players[h.shooter].s };
    const shots = h.type === 'dunk' ? this.planDunk(ctx) : this.planThree(ctx);
    for (const S of shots) if (S.tracer) S.path = this.flightPath(ctx);
    this.play = { ...h, shots, i: 0, t: shots[0].a, fresh: true, pos: V(), look: V(), fov: 40, shake: 0, flash: 0, sndFrom: 0, fired: new Set(), ctx };
    this.cueSounds(shots[0].a);
    this.saved = { fov: this.camera.fov, pos: this.camera.position.clone(), quat: this.camera.quaternion.clone() };
    this.active = true;
    this.lower(h, ctx);
    this.ui(true);
    this.sound.whoosh();
    this.startClip(h);
    this.update(0);          // the first frame is already the replay (not the live view)
  }

  // ----- planning helpers -----
  // a player's body centre / head at time t, from the track
  body(i, t, k = 1.12) { const q = this.trackAt(t).p[i]; return V(q.x, this.players[i].s * k + q.y, q.z); }
  ballAt(t) { return this.trackAt(t).b.clone(); }

  // vertical field of view that fits a w x h metre frame at distance d (portrait or landscape)
  fit(d, w, h, lo = 18, hi = 70) {
    const a = this.camera.aspect || 0.5;
    const v = Math.max(2 * Math.atan(h / (2 * d)), 2 * Math.atan(w / (2 * d * a)));
    return clamp(THREE.MathUtils.radToDeg(v), lo, hi);
  }

  // aim at a set of points and open the lens just enough to hold them all (with a margin), inside the
  // band of the screen between lo and hi (-1 bottom, 1 top) that the letterbox bars and the name strip leave clear
  frameAll(pos, pts, margin = 1.15, lo = -0.62, hi = 0.8) {
    const a = this.camera.aspect || 0.5;
    const cam = this._fc || (this._fc = new THREE.PerspectiveCamera());
    cam.position.copy(pos);
    const look = V();
    for (const p of pts) look.add(p);
    look.multiplyScalar(1 / pts.length);
    const D = look.distanceTo(pos), rt = V(), up = V(), fw = V(), d = V();
    let T = 0.5;
    // aim, measure where the points land, re-aim so they sit in the middle of the band (a few times: aiming moves them)
    for (let it = 0; it < 4; it++) {
      cam.lookAt(look); cam.updateMatrixWorld();
      rt.setFromMatrixColumn(cam.matrixWorld, 0); up.setFromMatrixColumn(cam.matrixWorld, 1); fw.setFromMatrixColumn(cam.matrixWorld, 2).negate();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) {
        d.copy(p).sub(pos);
        const z = Math.max(0.3, d.dot(fw)), x = d.dot(rt) / z, y = d.dot(up) / z;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      T = Math.max((y1 - y0) / (hi - lo), (x1 - x0) / (2 * a)) * margin;
      look.copy(pos).addScaledVector(fw, D).addScaledVector(rt, (x0 + x1) / 2 * D).addScaledVector(up, ((y0 + y1) / 2 - T * (hi + lo) / 2) * D);
    }
    const raw = THREE.MathUtils.radToDeg(2 * Math.atan(T));      // what it would take (more than the lens has: it can't hold them all)
    return { look, raw, fov: clamp(raw, 18, 80) };
  }

  // where a point lands on screen (-1..1) seen from pos through a view { look, fov }
  onScreen(pos, view, p) {
    const cam = this._fc || (this._fc = new THREE.PerspectiveCamera());
    cam.aspect = this.camera.aspect || 0.5; cam.fov = view.fov; cam.updateProjectionMatrix();
    cam.position.copy(pos); cam.lookAt(view.look); cam.updateMatrixWorld();
    return p.clone().project(cam);
  }

  // the ball's flight from the release to the rim, sampled once for the tracer
  flightPath(c) {
    const t0 = c.tRelease, t1 = c.m + 0.03, path = [];
    for (let i = 0; i < TRACE_N; i++) { const t = t0 + (t1 - t0) * i / (TRACE_N - 1); path.push({ t, p: this.ballAt(t) }); }
    return path;
  }

  // a camera position nudged out of anyone it would be inside (twice, for crowds)
  clear(pos, t) {
    const tr = this.trackAt(t);
    for (let pass = 0; pass < 2; pass++) {
      tr.p.forEach((q, i) => {
        if (pos.y > this.players[i].s * 2.1 + q.y + 0.1) return;
        const dx = pos.x - q.x, dz = pos.z - q.z, d = Math.hypot(dx, dz), min = 0.62;
        if (d >= min) return;
        if (d > 1e-3) { pos.x = q.x + dx * min / d; pos.z = q.z + dz * min / d; } else pos.x = q.x + min;
      });
    }
    return pos;
  }

  // keep a camera inside the building: off the stands, the LED boards and the stanchion
  inBounds(p) {
    const x = clamp(p.x, -8.8, 8.8), z = clamp(p.z, -2.2, COURT.len - 0.5), y = Math.max(0.45, p.y);
    if (this.meter) this.meter.m += Math.abs(x - p.x) + Math.abs(z - p.z) + (y - p.y);
    return p.set(x, y, z);
  }

  // a camera placed off a point, swung round it (at the same distance, up to a quarter turn) until it
  // stands inside the building; cost says how far it had to swing, and is high if it never fitted
  swing(base, off) {
    const p = V(), q = V();
    for (let k = 0; k <= 8; k++) {
      for (const s of k ? [1, -1] : [1]) {
        p.copy(off).applyAxisAngle(UP, s * k * Math.PI / 16).add(base);
        if (this.inBounds(q.copy(p)).distanceTo(p) < 0.3) return { pos: q, cost: k * 0.25 };
      }
    }
    return { pos: this.inBounds(p.copy(base).add(off)), cost: 20 };
  }

  // how many other players stand between a camera and what it looks at, over a shot
  // (plus a cost for a camera the walls have pushed far off its mark)
  blocked(shot, skip) {
    let n = 0;
    for (let k = 0; k <= 6; k++) {
      const t = shot.a + (shot.b - shot.a) * k / 6;
      this.meter = { m: 0 };
      const c = shot.cam(t), tr = this.trackAt(t);
      n += Math.max(0, this.meter.m - 0.5);
      this.meter = null;
      tr.p.forEach((q, i) => {
        if (i === skip) return;
        const top = this.players[i].s * 2.05 + q.y;
        for (let j = 1; j < 12; j++) {
          const u = j / 12;
          const x = c.pos.x + (c.look.x - c.pos.x) * u, y = c.pos.y + (c.look.y - c.pos.y) * u, z = c.pos.z + (c.look.z - c.pos.z) * u;
          if (y > top || y < q.y) continue;
          if (Math.hypot(x - q.x, z - q.z) < 0.34) { n++; break; }
        }
      });
    }
    return n;
  }

  // two mirror versions of a shot: keep the one with the clearer view
  pick(make, skip) {
    const A = make(1), B = make(-1);
    return this.blocked(B, skip) + (B.cost || 0) < this.blocked(A, skip) + (A.cost || 0) ? B : A;
  }

  // a rate curve: base speed, dipping smoothly to `low` around [t0, t1]
  ramp(base, low, t0, t1, e = 0.12) {
    return (t) => base - (base - low) * sstep(t0 - e, t0, t) * (1 - sstep(t1, t1 + e, t));
  }

  // ----- the dunk: drive, the slam from under the rim, the hang -----
  planDunk(c) {
    const { m, tShot, who, first, last } = c;
    const R = V(RIM.x, RIM.y, RIM.z);
    const S0 = this.body(who, tShot);
    const out = V(S0.x - R.x, 0, S0.z - R.z);
    if (out.lengthSq() < 0.04) out.set(0, 0, 1);
    out.normalize();
    const perp = V(out.z, 0, -out.x);
    const shots = [];
    // 1 · the drive: a sideline camera trucks alongside him, the rim coming into the frame
    const a1 = Math.max(first, tShot - 1.0), b1 = m - 0.08;
    shots.push(this.pick((side) => ({
      a: a1, b: b1, rate: (t) => 0.8 - 0.4 * sstep(b1 - 0.5, b1, t),
      cam: (t) => {
        const S = this.body(who, t), S2 = this.body(who, Math.min(t + 0.25, last));
        const pos = this.inBounds(V(S.x, 1.5, S.z).addScaledVector(perp, side * 6.2).addScaledVector(out, 0.4));
        const look = S.clone().lerp(S2, 0.35).lerp(R, 0.3 * sstep(b1 - 0.7, b1, t));
        return { pos, look, fov: this.fit(pos.distanceTo(look), 2.5, 3.6) };
      },
    }), who));
    // 2 · the slam, super slow: low under the rim, looking up at him coming in
    const a2 = m - 0.52, b2 = Math.min(last, m + 0.38);
    // the slam itself: the moment the game played the dunk sound (the basket counts a hair later)
    const hit = this.events.filter((e) => e.name === 'dunk' && e.t <= m + 0.02 && e.t >= m - 0.4).pop();
    const slam = hit ? hit.t : m - 0.01;
    shots.push(this.pick((side) => ({
      a: a2, b: b2, rate: this.ramp(0.45, 0.12, slam - 0.1, slam + 0.12, 0.14), lower: true,
      beats: [{ t: slam, fn: () => this.boom(1) }],
      cam: (t) => {
        const k = sstep(a2, b2, t);
        const pos = V(R.x, 0.85 + 0.2 * k, R.z).addScaledVector(out, -0.95 + 0.3 * k).addScaledVector(perp, side * (1.4 - 0.4 * k));
        pos.z = Math.max(0.2, pos.z);
        const look = this.body(who, t, 1.65).lerp(R, 0.42);
        return { pos: this.inBounds(pos), look, fov: Math.max(48, this.fit(pos.distanceTo(look), 2.6, 3.4)) };
      },
    }), who));
    // 3 · the hang: from the baseline corner, his face and the crowd going up
    const a3 = m + 0.04, b3 = Math.min(last, m + 1.15);
    if (b3 - a3 > 0.4) {
      shots.push(this.pick((side) => ({
        a: a3, b: b3, rate: () => 0.7, lower: true,
        cam: (t) => {
          const pos = this.inBounds(V(R.x, 2.45, R.z).addScaledVector(out, -1.55).addScaledVector(perp, side * 2.5));
          const look = this.body(who, t).lerp(R, 0.3);
          return { pos, look, fov: this.fit(pos.distanceTo(look), 2.6, 3.3) };
        },
      }), who));
    }
    return shots;
  }

  // ----- the three: the release, the flight with a tracer, the swish from under the net -----
  planThree(c) {
    const { m, tShot, tRelease, who, first, last } = c;
    const R = V(RIM.x, RIM.y, RIM.z);
    const S = this.body(who, tRelease);
    const dir = V(R.x - S.x, 0, R.z - S.z);
    c.dist = dir.length();
    dir.normalize();
    const perp = V(dir.z, 0, -dir.x);
    const shots = [];
    // 1 · the release: a long lens in front of him, a little off the line to the rim
    const a1 = Math.max(first, tShot - 0.4), b1 = Math.min(m - 0.3, tRelease + 0.28);
    shots.push(this.pick((side) => ({
      a: a1, b: b1, rate: (t) => 0.8 - 0.4 * sstep(tRelease - 0.35, tRelease, t),
      cam: (t) => {
        const H = this.body(who, t, 1.5);
        const pos = this.inBounds(V(H.x, 1.75, H.z).addScaledVector(dir, 4.8).addScaledVector(perp, side * 1.9));
        const look = H.clone().lerp(this.ballAt(t), 0.45 * sstep(tRelease, tRelease + 0.35, t));
        return { pos, look, fov: this.fit(pos.distanceTo(look), 1.8, 3.1) };
      },
    }), who));
    // 2 · the flight: high and wide behind him, the shooter, the whole arc and the rim in one frame, a tracer drawing it
    const a2 = tRelease + 0.02, b2 = Math.min(last, m + 0.25);
    let apex = S.clone();
    for (let t = tRelease; t <= m; t += 0.05) { const b = this.ballAt(t); if (b.y > apex.y) apex = b; }
    const H0 = this.body(who, tRelease, 1.7);
    shots.push(this.pick((side) => {
      const top = COURT.boardBottom + COURT.boardH, bw = COURT.boardW / 2;
      const pts = [H0, apex, R, V(S.x, 0.1, S.z), V(-bw, top, COURT.boardZ), V(bw, top, COURT.boardZ)];   // the shooter, the arc, the whole board
      const base = V(S.x, 3.4, S.z), off = V().addScaledVector(dir, -4.2).addScaledVector(perp, side * 1.6);
      const sw = this.swing(base, off);
      let pos = sw.pos, view = this.frameAll(pos, pts);
      // if that can't hold it all (a corner three, the wall behind him) a crane: pulled in to the wall and up
      // over his shoulder, the lowest that holds it all (higher shrinks him), else the one that comes closest
      if (view.raw > 80) {
        let best = null;
        crane: for (const lift of [2, 3.5, 5, 6.5]) {
          for (let f = 0.9; f > 0.15; f -= 0.1) {
            const p = base.clone().addScaledVector(off, f);
            if (this.inBounds(p.clone()).distanceTo(p) > 0.05) continue;
            p.y += lift;
            const v = this.frameAll(p, pts);
            if (!best || v.raw < best.v.raw) best = { p, v };
            if (v.raw <= 80) break crane;
          }
        }
        if (best && best.v.raw < view.raw) { pos = best.p; view = best.v; }
      }
      const end = pos.clone().addScaledVector(dir, 0.5);
      view = this.frameAll(end, pts);             // framed from the end of the push-in
      // pushed against a wall / can't hold it all / his feet under the name strip (bottom left)
      const feet = this.onScreen(end, view, V(S.x, 0, S.z));
      const cost = (pos === sw.pos && sw.cost >= 20 ? 3 : 0) + (view.raw > 80 ? 6 + (view.raw - 80) : 0) + (feet.x < 0.1 && feet.y < -0.5 ? 1.5 : 0);
      return {
        a: a2, b: b2, cost, rate: (t) => 0.78 - 0.4 * sstep(m - 0.45, m - 0.05, t), tracer: true, lower: true,
        cam: (t) => ({ pos: pos.clone().addScaledVector(dir, 0.5 * sstep(a2, b2, t)), look: view.look, fov: view.fov }),
      };
    }, who));
    // 3 · the swish, super slow: under the rim looking up and out, the ball dropping through the net at us
    const a3 = m - 0.24, b3 = Math.min(last, m + 0.26);
    shots.push(this.pick((side) => ({
      a: a3, b: b3, rate: this.ramp(0.34, 0.16, m - 0.12, m + 0.08, 0.1), tracer: true, lower: true,
      beats: [{ t: m, fn: () => this.boom(0.6) }],
      cam: () => {
        const pos = V(R.x, R.y - 1.5, R.z).addScaledVector(dir, 1.15).addScaledVector(perp, side * 0.5);
        const look = V(R.x, R.y + 0.3, R.z).addScaledVector(dir, -0.45);
        return { pos: this.inBounds(pos), look, fov: 56 };
      },
    }), -1));
    return shots;
  }

  // the moment: crowd up with flashes, a white pop, a small shake, the roar
  boom(v) {
    const P = this.play;
    P.flash = v >= 1 ? 0.75 : 0;
    P.shake = 0.25 * v;
    if (this.arena) this.arena.cheer(1.2 * v + 0.3, true);
    this.sound.play('roar', { gain: 0.45 + 0.25 * v, bus: this.sound.crowd });
  }

  // start the ball sounds from a shot's first moment
  cueSounds(t) {
    const i = this.events.findIndex((e) => e.t >= t);
    this.play.sndFrom = i < 0 ? this.events.length : i;
  }

  update(realDt) {
    const P = this.play;
    let S = P.shots[P.i];
    if (P.t >= S.b) {
      // cut to the next angle (the same moment again, from somewhere else)
      if (++P.i >= P.shots.length) { this.finish(); return; }
      S = P.shots[P.i];
      P.t = S.a; P.fresh = true;
      this.cueSounds(S.a);
      this.sound.whoosh();
    }
    const r = S.rate(P.t);
    P.t = Math.min(S.b, P.t + realDt * r);
    const st = this.apply(P.t);
    // ball sounds, lower in pitch the slower it runs
    const pitch = clamp(0.55 + 0.45 * r, 0.6, 1);
    while (P.sndFrom < this.events.length && this.events[P.sndFrom].t <= P.t) {
      const e = this.events[P.sndFrom++];
      const v = typeof e.args[0] === 'number' ? e.args[0] : 1;
      if (e.name === 'swish') this.sound.play('swish', { gain: 0.9, rate: pitch });
      else if (e.name === 'rim') this.sound.play('rim', { gain: clamp(0.5 + v * 0.2, 0.5, 1), rate: pitch, pan: e.args[1] || 0 });
      else if (e.name === 'board') this.sound.play('board', { gain: 0.8, rate: pitch, pan: e.args[1] || 0 });
      else if (e.name === 'dunk') this.sound.play('dunk', { gain: 1, rate: Math.min(pitch, 0.7) });
      else if (e.name === 'dribble') this.sound.play('dribble', { gain: 0.5, rate: pitch, pan: e.args[1] || 0 });
    }
    for (const [k, b] of (S.beats || []).entries()) {
      const key = P.i + ':' + k;
      if (!P.fired.has(key) && P.t >= b.t) { P.fired.add(key); b.fn(); }
    }
    this.direct(S, realDt);
    this.overlay(S, r, realDt);
  }

  // the camera: each shot's rig, eased (a hard cut between shots), kept out of bodies, with a little shake
  direct(S, dt) {
    const P = this.play, cam = this.camera;
    const c = S.cam(P.t);
    this.inBounds(this.clear(c.pos, P.t));
    if (P.fresh) { P.pos.copy(c.pos); P.look.copy(c.look); P.fov = c.fov; P.fresh = false; }
    else {
      P.pos.lerp(c.pos, 1 - Math.exp(-dt * 10));
      P.look.lerp(c.look, 1 - Math.exp(-dt * 8));
      P.fov += (c.fov - P.fov) * (1 - Math.exp(-dt * 6));
    }
    cam.position.copy(P.pos);
    if (P.shake > 0.001) {
      P.shake *= Math.exp(-dt * 7);
      cam.position.x += (Math.random() - 0.5) * P.shake * 0.12;
      cam.position.y += (Math.random() - 0.5) * P.shake * 0.12;
    }
    cam.fov = P.fov;
    cam.updateProjectionMatrix();
    cam.lookAt(P.look);
    this.trace(S.tracer ? S : null);
  }

  // the tracer's mesh, its shader built ahead (so the first three's replay doesn't stall at the cut)
  makeTracer() {
    if (!this.tracer) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACE_N * 2 * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRACE_N * 2 * 4), 4));
      const idx = [];
      for (let i = 0; i < TRACE_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      geo.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
      this.tracer = new THREE.Mesh(geo, mat);
      this.tracer.frustumCulled = false;
      this.tracer.renderOrder = 5;
    }
    // built twice, with the arena's lights and fog: drawn to the screen, and drawn into a target (the floor reflection,
    // the effects pass), which three.js treats as a different shader
    const sc = this.ball && this.ball.mesh.parent, R = this.renderer;
    if (sc && R && R.compile) {
      const tmp = new THREE.Scene(), prev = R.getRenderTarget(), rt = new THREE.WebGLRenderTarget(1, 1);
      tmp.add(this.tracer);
      try {
        R.compile(tmp, this.camera, sc);
        R.setRenderTarget(rt);
        R.compile(tmp, this.camera, sc);
      } catch (e) { /* built on first use instead */ } finally {
        R.setRenderTarget(prev); rt.dispose(); tmp.remove(this.tracer);
      }
    }
  }

  // the tracer: a Livewire-yellow ribbon along the ball's flight since the release
  trace(S) {
    if (!this.tracer) this.makeTracer();
    const M = this.tracer;
    const P = this.play;
    if (!S || !P || !S.path) { if (M.parent) M.parent.remove(M); return; }
    if (!M.parent) this.ball.mesh.parent.add(M);
    // the drawn part of the path: from the release up to now (and the ball's own spot at the head)
    const path = S.path, n = TRACE_N, t = P.t;
    let k = 0;
    while (k < n - 1 && path[k + 1].t <= t) k++;
    const head = t < path[n - 1].t ? this.ball.mesh.position : path[n - 1].p;
    const pos = M.geometry.attributes.position.array, col = M.geometry.attributes.color.array;
    const cam = this.camera.position, yel = this.yel || (this.yel = new THREE.Color(BRAND.yellow));
    const p = _p, prev = _q, along = _r, side = _s;
    prev.copy(path[0].p);
    for (let i = 0; i < n; i++) {
      // spread the drawn points along [0, k] plus the live head
      const f = (i / (n - 1)) * (k + 1);
      const j = Math.min(k, Math.floor(f));
      if (j >= k) p.copy(path[k].p).lerp(head, Math.min(1, f - k));
      else p.copy(path[j].p).lerp(path[j + 1].p, f - j);
      along.copy(p).sub(prev); if (along.lengthSq() < 1e-8) along.set(1, 0, 0);
      const d = p.distanceTo(cam);
      side.copy(along).cross(_q2.copy(p).sub(cam)).normalize().multiplyScalar(0.007 * d * (0.35 + 0.65 * i / (n - 1)));   // same width on screen at any distance
      if (!(side.lengthSq() < 1)) side.set(0, 0, 0);
      pos.set([p.x + side.x, p.y + side.y, p.z + side.z, p.x - side.x, p.y - side.y, p.z - side.z], i * 6);
      const a = Math.pow(i / (n - 1), 1.6) * 0.95 * sstep(0.8, 2.2, d);                                          // and gone right by the lens
      col.set([yel.r, yel.g, yel.b, a, yel.r, yel.g, yel.b, a], i * 8);
      prev.copy(p);
    }
    M.geometry.attributes.position.needsUpdate = true;
    M.geometry.attributes.color.needsUpdate = true;
  }

  // the dressing: the name strip, SUPER SLO-MO while it crawls, the white pop on the moment
  overlay(S, r, dt) {
    const P = this.play;
    P.flash = Math.max(0, P.flash - dt * 2.6);
    P.slo = r < 0.3;
    P.lowerOn = !!S.lower;
    const el = this.el || (this.el = {
      lower: document.getElementById('rpLower'), slo: document.getElementById('rpSlo'), flash: document.getElementById('rpFlash'),
    });
    if (el.lower) el.lower.classList.toggle('on', P.lowerOn);
    if (el.slo) el.slo.classList.toggle('on', P.slo);
    if (el.flash) el.flash.style.opacity = P.flash.toFixed(3);
  }

  // the name strip's words: who, and what it was
  lower(h, c) {
    const p = this.players[h.shooter].info;
    const what = h.winning ? 'GAME WINNER'
      : h.type === 'dunk' ? (h.big ? 'MONSTER SLAM' : 'SLAM')
        : `FROM DEEP · ${Math.round((c.dist || 7.24) * 3.281)} FT`;
    this.words = { name: (p.last || '').toUpperCase(), num: `#${p.num}`, what };
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('rpName', this.words.name); set('rpNum', this.words.num); set('rpWhat', this.words.what);
  }

  skip() { if (this.active) this.finish(); }

  finish() {
    if (!this.active) return;
    this.active = false;
    this.trace(null);
    if (this.play) { this.play.flash = 0; this.play.lowerOn = false; this.play.slo = false; }
    if (this.el) { this.el.lower && this.el.lower.classList.remove('on'); this.el.slo && this.el.slo.classList.remove('on'); if (this.el.flash) this.el.flash.style.opacity = '0'; }
    this.apply(this.times[this.idx(this.count - 1)]);       // back to the live state
    const c = this.camera, s = this.saved;
    c.fov = s.fov; c.position.copy(s.pos); c.quaternion.copy(s.quat); c.updateProjectionMatrix();
    this.ui(false);
    this.sound.whoosh();
    this.stopClip();
    const done = this.onDone; this.onDone = null;
    if (done) done();
  }

  ui(on) {
    const el = document.getElementById('replayUI');
    if (!el) return;
    el.hidden = !on;
    if (on) { el.classList.remove('wipe'); void el.offsetWidth; el.classList.add('wipe'); }
  }

  // ---------- the shareable clip ----------
  startClip(h) {
    this.rec = null;
    const MR = window.MediaRecorder;
    const gl = this.renderer.domElement;
    if (!MR || !HTMLCanvasElement.prototype.captureStream) return;
    try {
      // the clip keeps the game's shape: vertical on a phone (ready for Reels and TikTok), 16:9 on a computer
      const port = gl.height > gl.width;
      const W = port ? 720 : 1280, H = port ? 1280 : 720;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const stream = c.captureStream(30);
      const ctx = this.sound.ctx, master = this.sound.master;
      // the game's sound goes into the clip only while it records
      let dest = null;
      if (ctx && master && ctx.createMediaStreamDestination) {
        dest = ctx.createMediaStreamDestination();
        master.connect(dest);
        for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
      }
      const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      const type = types.find((t) => MR.isTypeSupported && MR.isTypeSupported(t)) || '';
      const mr = new MR(stream, type ? { mimeType: type, videoBitsPerSecond: 5e6 } : { videoBitsPerSecond: 5e6 });
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        for (const tr of stream.getTracks()) tr.stop();
        if (dest) try { master.disconnect(dest); } catch (e) { /* already gone */ }
        const mime = (mr.mimeType || type || 'video/webm').split(';')[0];
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: mime });
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        this.clip = { blob, name: `livewire-hoops-${h.type}.${ext}` };
        if (this.onClip) this.onClip(this.clip);
      };
      mr.start(250);
      this.rec = { mr, c, g, W, H, gl, h };
    } catch (e) {
      console.warn('clip recording unavailable', e);
      this.rec = null;
    }
  }

  // called right after each replay frame is rendered (the WebGL buffer is still valid then)
  capture() {
    const r = this.rec;
    if (!r) return;
    const { g, W, H, gl } = r;
    // cover-crop the game canvas into the clip's frame
    const sw = gl.width, sh = gl.height, ar = W / H;
    let cw = sw, ch = sw / ar;
    if (ch > sh) { ch = sh; cw = sh * ar; }
    g.drawImage(gl, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);
    const P = this.play || {};
    if (!r.vig) { const R0 = Math.min(W, H), R1 = Math.hypot(W, H) * 0.55; r.vig = g.createRadialGradient(W / 2, H * 0.46, R0 * 0.5, W / 2, H * 0.46, R1); r.vig.addColorStop(0, 'rgba(0,0,0,0)'); r.vig.addColorStop(1, 'rgba(0,0,0,0.45)'); }
    g.fillStyle = r.vig; g.fillRect(0, 0, W, H);
    if (P.flash > 0.01) { g.fillStyle = `rgba(255,255,255,${Math.min(1, P.flash)})`; g.fillRect(0, 0, W, H); }
    // the name strip and SUPER SLO-MO, as on screen
    if (P.lowerOn && this.words) {
      const w = this.words, x = 28, y = H - 54 - 30 - 74;
      g.textBaseline = 'middle';
      g.font = '900 40px "Saira Extra Condensed", "Arial Narrow", sans-serif';
      const nw = g.measureText(w.name).width;
      g.font = '800 28px "Saira Extra Condensed", "Arial Narrow", sans-serif';
      const uw = g.measureText(w.num).width;
      const bw = nw + uw + 50;
      g.fillStyle = BRAND.yellow;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + bw, y); g.lineTo(x + bw - 14, y + 48); g.lineTo(x, y + 48); g.closePath(); g.fill();
      g.fillStyle = '#111';
      g.font = '900 40px "Saira Extra Condensed", "Arial Narrow", sans-serif'; g.fillText(w.name, x + 16, y + 26);
      g.font = '800 28px "Saira Extra Condensed", "Arial Narrow", sans-serif'; g.fillText(w.num, x + 16 + nw + 12, y + 28);
      g.font = '800 20px "Saira Extra Condensed", "Arial Narrow", sans-serif';
      const sw2 = g.measureText(w.what).width + 32;
      g.fillStyle = '#111'; g.fillRect(x, y + 48, sw2, 32);
      g.fillStyle = '#f1f3f6'; g.fillText(w.what, x + 16, y + 65);
    }
    if (P.slo) {
      g.font = '800 20px "Saira Extra Condensed", "Arial Narrow", sans-serif';
      g.textBaseline = 'middle'; g.fillStyle = BRAND.yellow;
      const tx = 'SUPER SLO-MO';
      g.fillText(tx, W - g.measureText(tx).width - 28, 54 + 30);
    }
    // broadcast dressing: letterbox, Livewire mark, replay tag, score, address
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, 54); g.fillRect(0, H - 54, W, 54);
    if (!this._wm) this._wm = new Path2D(BRAND.wordmark.d);
    g.save(); g.translate(28, 16); g.scale(22 / BRAND.wordmark.h, 22 / BRAND.wordmark.h); g.fillStyle = BRAND.yellow; g.fill(this._wm); g.restore();
    g.font = '800 26px "Saira Extra Condensed", "Arial Narrow", sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText('HOOPS', 28 + BRAND.wordmark.w * 22 / BRAND.wordmark.h + 12, 28);
    const tag = r.h.type === 'dunk' ? 'REPLAY · SLAM' : 'REPLAY · FROM DEEP';
    g.font = '800 22px "Saira Extra Condensed", "Arial Narrow", sans-serif';
    const tw = g.measureText(tag).width;
    g.fillStyle = BRAND.yellow; g.fillRect(W - tw - 52, 12, tw + 28, 32);
    g.fillStyle = '#111'; g.fillText(tag, W - tw - 38, 29);
    const sc = this.game.score;
    g.fillStyle = '#ffffff'; g.font = '700 22px "Saira Extra Condensed", "Arial Narrow", sans-serif';
    g.fillText(`${r.h.names[0]} ${sc[0]}  –  ${sc[1]} ${r.h.names[1]}`, 28, H - 27);
    g.fillStyle = 'rgba(255,255,255,0.75)';
    const url = 'livewire.hoops.gamify.com';
    g.fillText(url, W - g.measureText(url).width - 28, H - 27);
  }

  stopClip() {
    const r = this.rec; this.rec = null;
    if (!r) return;
    // the crowd keeps going for a moment after the last frame
    setTimeout(() => { try { r.mr.stop(); } catch (e) { /* already stopped */ } }, 120);
  }
}

// share the clip (phones: the system share sheet, e.g. Instagram, TikTok,
// Messages); where sharing files isn't possible, save it instead
export async function shareClip(clip) {
  if (!clip) return;
  const file = new File([clip.blob], clip.name, { type: clip.blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Livewire Hoops', text: 'Livewire Hoops · livewire.hoops.gamify.com' }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(clip.blob);
  a.download = clip.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  return 'saved';
}
