// Highlight replays. Every frame the last few seconds of play are recorded:
// the players' bones, their shadows and loose kit, the ball and the net, plus
// the ball sounds. After your threes and dunks the play runs again in slow
// motion from broadcast angles, while a branded video clip (with the crowd
// audio) is recorded for sharing.
import * as THREE from 'three';
import { RIM } from './arena.js';
import { BRAND } from './data.js';

const KEEP = 7;          // seconds of play kept
const MAXF = 720;        // frame slots (KEEP s at up to ~100 fps)
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const SOUNDS = ['dribble', 'rim', 'board', 'swish', 'dunk'];

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
  bind({ players, ball, net, game, renderer }) {
    if (renderer) this.renderer = renderer;
    this.players = players; this.ball = ball; this.net = net; this.game = game;
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
    this.head = 0; this.count = 0;
    this.events = [];
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

  // apply the recorded state at time t (interpolated between frames)
  apply(t) {
    let lo = 0, hi = this.count - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.times[this.idx(m)] <= t) lo = m; else hi = m - 1; }
    const ia = this.idx(lo), ib = this.idx(Math.min(this.count - 1, lo + 1));
    const ta = this.times[ia], tb = this.times[ib];
    const u = tb > ta ? clamp((t - ta) / (tb - ta), 0, 1) : 0;
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

  // seconds of real time after the basket before the replay rolls
  tickPending(realDt) {
    if (!this.pending) return false;
    this.pending.wait += realDt;
    return this.pending.wait > 1.25;
  }

  start() {
    const h = this.pending; this.pending = null;
    const g = this.game;
    // the play starts when the shooter gathered: find that state change before the basket
    let tShot = h.tMake - 2.5, tRelease = h.tMake - 1;
    for (let i = this.count - 1; i > 0; i--) {
      const s = this.states[this.idx(i)], prev = this.states[this.idx(i - 1)];
      const t = this.times[this.idx(i)];
      if (t > h.tMake) continue;
      if (s === 'shot' && prev !== 'shot') tRelease = t;
      if ((s === 'shooting' || s === 'finishing') && prev !== s) { tShot = t; break; }
    }
    const t0 = Math.max(this.times[this.idx(0)], tShot - 0.7);
    const t1 = Math.min(g.t, h.tMake + 1.2);
    const shooter = this.players[h.shooter], defender = this.players[1 - h.shooter];
    // where the defender is at the basket: the cameras go on the other side so he doesn't block the shot
    this.apply(h.tMake);
    const D = this.bodyPos(defender);
    this.apply(t0);
    // where the shooter stood when the play began (the recorded body, not the live one)
    const S = this.bodyPos(shooter).setY(0);
    const dunkCam = (sd) => new THREE.Vector3(sd * 2.2, 1.3, RIM.z + 2.2);
    let side;
    if (h.type === 'dunk') side = dunkCam(1).distanceTo(D) >= dunkCam(-1).distanceTo(D) ? 1 : -1;
    else {
      const d = new THREE.Vector3(RIM.x - S.x, 0, RIM.z - S.z).normalize();
      const cam = (sd) => S.clone().addScaledVector(d, 2.1).addScaledVector(new THREE.Vector3(d.z, 0, -d.x), sd * 1.9);
      side = cam(1).distanceTo(D) >= cam(-1).distanceTo(D) ? 1 : -1;
    }
    this.play = { ...h, t: t0, t0, t1, tShot, tRelease, S, side, look: null, cut: -1, sndI: 0, made: false, shooter };
    this.sndFrom = this.events.findIndex((e) => e.t >= t0);
    if (this.sndFrom < 0) this.sndFrom = this.events.length;
    this.saved = { fov: this.camera.fov, pos: this.camera.position.clone(), quat: this.camera.quaternion.clone() };
    this.active = true;
    this.ui(true);
    this.sound.whoosh();
    this.startClip(h);
  }

  bodyPos(p) {
    p.group.updateMatrixWorld(true);
    return (p.skin ? p.skin.bones.Hips : p.root).getWorldPosition(new THREE.Vector3());
  }

  // slow motion around the basket
  rate(t) {
    const P = this.play, m = P.tMake;
    const slow = sstep(m - 1.05, m - 0.45, t) * (1 - sstep(m + 0.35, m + 1.0, t));
    return 1 - 0.66 * slow;
  }

  update(realDt) {
    const P = this.play;
    P.t = Math.min(P.t1, P.t + realDt * this.rate(P.t));
    const st = this.apply(P.t);
    // ball sounds, a little lower in pitch for the slow motion
    while (this.sndFrom < this.events.length && this.events[this.sndFrom].t <= P.t) {
      const e = this.events[this.sndFrom++];
      const v = typeof e.args[0] === 'number' ? e.args[0] : 1;
      const rate = 0.82;
      if (e.name === 'swish') this.sound.play('swish', { gain: 0.9, rate });
      else if (e.name === 'rim') this.sound.play('rim', { gain: clamp(0.5 + v * 0.2, 0.5, 1), rate, pan: e.args[1] || 0 });
      else if (e.name === 'board') this.sound.play('board', { gain: 0.8, rate, pan: e.args[1] || 0 });
      else if (e.name === 'dunk') this.sound.play('dunk', { gain: 1, rate });
      else if (e.name === 'dribble') this.sound.play('dribble', { gain: 0.5, rate, pan: e.args[1] || 0 });
    }
    if (!P.made && P.t >= P.tMake) { P.made = true; this.sound.play('roar', { gain: 0.5, bus: this.sound.crowd }); }
    this.direct(st.ball, realDt);
    if (P.t >= P.t1) this.finish();
  }

  // broadcast camera: a shooter cam, then a rim cam with the crowd behind; dunks get a low hero angle
  direct(ball, dt) {
    const P = this.play, cam = this.camera, S = P.S, side = P.side;
    const body = this.bodyPos(P.shooter);
    let cut, pos, look;
    if (P.type === 'dunk') {
      cut = 0;
      const k = clamp((P.t - P.t0) / Math.max(0.5, P.t1 - P.t0), 0, 1);
      pos = new THREE.Vector3(side * (2.2 - k * 0.35), 1.3 + k * 0.2, RIM.z + 2.2 - k * 0.3);
      look = new THREE.Vector3().lerpVectors(body.clone().setY(body.y + 0.45), new THREE.Vector3(RIM.x, RIM.y - 0.2, RIM.z), sstep(P.tMake - 0.6, P.tMake, P.t) * 0.55);
    } else if (P.t < P.tRelease + 0.3) {
      cut = 0;
      const d = new THREE.Vector3(RIM.x - S.x, 0, RIM.z - S.z).normalize();
      const r = new THREE.Vector3(d.z, 0, -d.x).multiplyScalar(side);
      const k = clamp((P.t - P.t0) / Math.max(0.5, P.tRelease + 0.3 - P.t0), 0, 1);
      pos = S.clone().addScaledVector(d, 2.1 - k * 0.3).addScaledVector(r, 1.9).setY(1.3 + k * 0.3);
      look = new THREE.Vector3().lerpVectors(body.clone().setY(body.y + 0.55), ball, sstep(P.tRelease - 0.15, P.tRelease + 0.3, P.t) * 0.4);
    } else {
      cut = 1;
      const k = clamp((P.t - P.tRelease) / Math.max(0.5, P.t1 - P.tRelease), 0, 1);
      pos = new THREE.Vector3(side * (3.1 - k * 0.3), 3.25 - k * 0.15, 6.2 - k * 0.5);
      look = new THREE.Vector3().lerpVectors(ball, RIM, 0.55);
    }
    if (cut !== P.cut || !P.look) { P.cut = cut; P.look = look.clone(); }   // hard cut
    else P.look.lerp(look, 1 - Math.exp(-dt * 7));
    cam.fov = P.type === 'dunk' ? 52 : 36;
    cam.updateProjectionMatrix();
    cam.position.copy(pos);
    cam.lookAt(P.look);
  }

  skip() { if (this.active) this.finish(); }

  finish() {
    if (!this.active) return;
    this.active = false;
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
      const W = 1280, H = 720;
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
    // cover-crop the game canvas into 16:9
    const sw = gl.width, sh = gl.height, ar = W / H;
    let cw = sw, ch = sw / ar;
    if (ch > sh) { ch = sh; cw = sh * ar; }
    g.drawImage(gl, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);
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
