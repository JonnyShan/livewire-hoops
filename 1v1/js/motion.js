// Motion-capture layer. Mocap clips (Higgsfield / Meshy animation library) are
// blended by speed and direction, and jumps are time-warped onto the game's own
// jump timing. Clips store each bone's world rotation relative to its rest
// pose, so one library drives every player's body.
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

let libP = null;
export function loadMotion(url) {
  if (!libP) {
    libP = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); })
      .then((lib) => {
        for (const c of Object.values(lib.clips)) {
          c.q = Float32Array.from(c.q);
          c.hips = Float32Array.from(c.hips);
          c.cycleDur = c.dur / c.cycles;
          c.stride = c.speed * c.cycleDur;
        }
        lib.index = Object.fromEntries(lib.bones.map((b, i) => [b, i]));
        return lib;
      });
    libP.catch(() => { libP = null; });
  }
  return libP;
}

// accumulate one clip's pose at time t with weight w (quaternions nlerped)
function sampleClip(lib, clip, t, w, acc, hips) {
  const nb = lib.bones.length, n = clip.frames;
  let f = t * lib.fps;
  if (clip.loop) { f %= n; if (f < 0) f += n; } else f = clamp(f, 0, n - 1);
  const f0 = Math.floor(f), u = f - f0;
  const f1 = clip.loop ? (f0 + 1) % n : Math.min(n - 1, f0 + 1);
  const Q = clip.q, o0 = f0 * nb * 4, o1 = f1 * nb * 4;
  for (let b = 0; b < nb; b++) {
    const i0 = o0 + b * 4, i1 = o1 + b * 4, k = b * 4;
    const x0 = Q[i0], y0 = Q[i0 + 1], z0 = Q[i0 + 2], w0 = Q[i0 + 3];
    let x1 = Q[i1], y1 = Q[i1 + 1], z1 = Q[i1 + 2], w1 = Q[i1 + 3];
    if (x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1 < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; }
    const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u, z = z0 + (z1 - z0) * u, ww = w0 + (w1 - w0) * u;
    const s = acc[k] * x + acc[k + 1] * y + acc[k + 2] * z + acc[k + 3] * ww < 0 ? -w : w;
    acc[k] += x * s; acc[k + 1] += y * s; acc[k + 2] += z * s; acc[k + 3] += ww * s;
  }
  const H = clip.hips, h0 = f0 * 3, h1 = f1 * 3;
  for (let a = 0; a < 3; a++) hips[a] += (H[h0 + a] + (H[h1 + a] - H[h0 + a]) * u) * w;
}

export class MotionLayer {
  constructor(player, lib) {
    this.p = player;
    this.lib = lib;
    const C = lib.clips, nb = lib.bones.length;
    this.q = new Float32Array(nb * 4);
    this.h = new Float32Array(3);
    this.phase = Math.random();                 // gait cycles, shared by every moving clip
    this.idleT = Math.random() * 20;
    this.w = {};
    for (const k in C) this.w[k] = 0;
    this.w.idle = 1;
    this.def = 0;                               // offense -> defense idle blend
    this.bodyW = 0;                             // mocap vs procedural (legs, hips, spine)
    this.armW = [0, 0];
    this.jumpW = 0;
    this.air = 0;                               // airborne part of a jump
    this.legW = 0;
    this.lastAct = null;
    const moving = (n) => C[n] && C[n].speed > 0.3;
    this.fwd = ['walk', 'jog', 'run', 'sprint'].filter(moving).sort((a, b) => C[a].speed - C[b].speed);
    this.back = ['back'].filter(moving);
    // the side-step clips say which way they travel (+x is the character's left)
    const sides = ['slideL', 'slideR'].filter(moving);
    this.left = sides.filter((n) => C[n].dir[0] > 0);
    this.right = sides.filter((n) => C[n].dir[0] < 0);
  }

  // clip time inside the jump for the game's jump timeline (dip, air, landing)
  jumpTime(act) {
    const c = this.lib.clips.jump;
    const t0 = act.type === 'shoot' ? 0.2 : 0.1;
    const pre = Math.min(c.takeoff, 0.3);
    const g = act.t;
    if (g < t0) return c.takeoff - pre + (g / t0) * pre;
    if (g < t0 + act.air) return c.takeoff + ((g - t0) / act.air) * (c.land - c.takeoff);
    return c.land + (g - t0 - act.air) * 1.2;
  }

  update(dt) {
    const p = this.p, lib = this.lib, C = lib.clips;
    const act = p.action;
    const k = (r) => 1 - Math.exp(-dt * r);
    // --- which layer owns the body ---
    const jumping = act && (act.type === 'contest' || act.type === 'shoot') && C.jump;
    const standing = !act || act.type === 'check' || act.type === 'celebrate';
    this.bodyW += ((jumping || standing ? 1 : 0) - this.bodyW) * k(jumping ? 22 : 12);
    this.jumpW += ((jumping ? 1 : 0) - this.jumpW) * k(jumping ? 30 : 8);
    for (let i = 0; i < 2; i++) {
      let t = act ? 0 : 1 - p.ikW[i];
      if (!act && p.stance === 'defense') t *= 0.35;
      if (!act && p.dribble.active && (i === 0 ? -1 : 1) !== p.dribble.hand) t *= 0.5;   // off-hand arm bar
      this.armW[i] += (t - this.armW[i]) * k(12);
    }
    // --- locomotion weights by speed and direction ---
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const vf = p.vel.x * fx + p.vel.z * fz;
    const vl = p.vel.x * fz - p.vel.z * fx;
    const spd = Math.hypot(vf, vl);
    const cf = spd > 0.05 ? vf / spd : 1, cl = spd > 0.05 ? vl / spd : 0;
    const T = {};
    for (const n in C) T[n] = 0;
    let idle = 0, strideSum = 0, cycSum = 0, moveSum = 0;
    const groups = [[cf > 0 ? cf * cf : 0, this.fwd], [cf < 0 ? cf * cf : 0, this.back],
      [cl > 0 ? cl * cl : 0, this.left], [cl < 0 ? cl * cl : 0, this.right]];
    for (const [g, fam] of groups) {
      if (g < 1e-3) continue;
      if (!fam.length) { idle += g; continue; }
      const a0 = C[fam[0]];
      if (spd <= a0.speed) {
        const u = spd / a0.speed;
        idle += g * (1 - u);
        T[fam[0]] += g * u;
        strideSum += g * u * a0.stride; cycSum += g * u * a0.cycleDur; moveSum += g * u;
        continue;
      }
      let i = 0;
      while (i < fam.length - 1 && spd > C[fam[i + 1]].speed) i++;
      if (i === fam.length - 1) {
        T[fam[i]] += g;
        strideSum += g * C[fam[i]].stride; cycSum += g * C[fam[i]].cycleDur; moveSum += g;
      } else {
        const a = C[fam[i]], b = C[fam[i + 1]];
        const u = (spd - a.speed) / (b.speed - a.speed);
        T[fam[i]] += g * (1 - u); T[fam[i + 1]] += g * u;
        strideSum += g * ((1 - u) * a.stride + u * b.stride); cycSum += g * ((1 - u) * a.cycleDur + u * b.cycleDur); moveSum += g;
      }
    }
    // defenders sit in a stance; a stationary dribbler half-crouches
    this.def += ((p.stance === 'defense' ? 1 : p.dribble.active ? 0.55 : 0) - this.def) * k(5);
    if (C.defIdle) { T.idle += idle * (1 - this.def); T.defIdle += idle * this.def; } else T.idle += idle;
    if (T.jump !== undefined) T.jump = 0;
    // feet stay planted up to 1.35x a clip's own tempo; past that they may glide a little
    const stride = moveSum > 1e-4 ? strideSum / moveSum : 1;
    const cyc = moveSum > 1e-4 ? cycSum / moveSum : 1;
    this.phase += dt * Math.min(spd / Math.max(0.3, stride), 1.35 / cyc);
    this.idleT += dt;
    const kw = k(9);
    for (const n in T) this.w[n] += (T[n] - this.w[n]) * kw;

    // --- sample ---
    const q = this.q, h = this.h;
    q.fill(0); h.fill(0);
    let tot = 0;
    for (const n in this.w) if (n !== 'jump') tot += this.w[n];
    const locoShare = 1 - this.jumpW;
    let used = 0;
    for (const n in this.w) {
      if (n === 'jump') continue;
      const w = (this.w[n] / Math.max(1e-6, tot)) * locoShare;
      if (w < 0.01) continue;
      const c = C[n];
      const t = c.speed > 0.3 ? c.phase0 + (this.phase % c.cycles) * c.cycleDur : this.idleT;
      sampleClip(lib, c, t, w, q, h);
      used += w;
    }
    if (this.jumpW > 0.01 && C.jump) {
      if (jumping) this.lastAct = act;
      const ja = jumping ? act : this.lastAct;
      if (ja) {
        const jt = this.jumpTime(ja);
        sampleClip(lib, C.jump, jt, this.jumpW, q, h); used += this.jumpW;
        // the library jump tucks its knees; in the air the legs stay long, like a shot or block
        const inAir = jt > C.jump.takeoff + 0.03 && jt < C.jump.land - 0.03 ? 1 : 0;
        this.air += (inAir - this.air) * k(18);
      }
    } else this.air += (0 - this.air) * k(18);
    this.legW = this.bodyW * (1 - 0.7 * this.air * this.jumpW);
    for (let b = 0; b < q.length; b += 4) {
      const l = Math.hypot(q[b], q[b + 1], q[b + 2], q[b + 3]);
      if (l < 1e-6) { q[b] = q[b + 1] = q[b + 2] = 0; q[b + 3] = 1; continue; }
      q[b] /= l; q[b + 1] /= l; q[b + 2] /= l; q[b + 3] /= l;
    }
    if (used > 0) for (let a = 0; a < 3; a++) h[a] /= used;
  }

  // rest-relative delta for bone i as a THREE.Quaternion
  delta(i, out) {
    const q = this.q, k = i * 4;
    return out.set(q[k], q[k + 1], q[k + 2], q[k + 3]);
  }
}

export const MOTION_URL = 'models/motion.json';
