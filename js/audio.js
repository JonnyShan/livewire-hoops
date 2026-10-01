// Arena audio. The crowd is real recordings of big crowds and the rim is built
// from real recordings of a basketball and a steel hoop (Freesound, CC0); the
// swish, backboard, dribble and dunk were generated with ElevenLabs. Every
// sound has a synthesised fallback that plays until the files are decoded or
// if they fail to load.
const SFX = {
  bed: ['sfx/crowd-bed.mp3'],
  roar: ['sfx/crowd-roar-1.mp3', 'sfx/crowd-roar-2.mp3'],
  swish: ['sfx/swish.mp3'],
  board: ['sfx/backboard.mp3'],
  rim: ['sfx/rim-1.mp3', 'sfx/rim-2.mp3', 'sfx/rim-3.mp3'],
  dribble: ['sfx/dribble.mp3'],
  dunk: ['sfx/dunk.mp3'],
};
// crowd clips play from the top; impacts are trimmed to their first transient
const CROWD = new Set(['bed', 'roar']);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.excite = 0;
    this.buf = {};
    this.swell = 0;          // the crowd noise building while a three is in the air
    this.dip = 0;            // ...and falling away after a miss or an opponent's score
    this.raw = null;
  }

  // download the sound files (decoding waits for the audio unlock tap)
  preload() {
    if (this.raw) return;
    this.raw = {};
    for (const [k, files] of Object.entries(SFX)) {
      this.raw[k] = files.map((f) => fetch(f).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
    }
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    // noise buffers for the synthesised fallbacks
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
      }
    }
    this.pink = buf;
    const wb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const wd = wb.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    this.white = wb;
    // crowd bus: everything the crowd does goes through one filter that opens up with excitement
    this.crowdLp = ctx.createBiquadFilter(); this.crowdLp.type = 'lowpass'; this.crowdLp.frequency.value = 9000;
    this.crowd = ctx.createGain(); this.crowd.gain.value = 1;
    this.crowd.connect(this.crowdLp).connect(this.master);
    // synthesised crowd bed until the recorded one is ready
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.6;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    this.synthBed = ctx.createGain(); this.synthBed.gain.value = 0.18;
    src.connect(bp).connect(lp).connect(this.synthBed).connect(this.crowd);
    src.start();
    this.bed = null;
    this.preload();
    this.decodeAll();
  }

  async decodeAll() {
    const ctx = this.ctx;
    await Promise.all(Object.entries(this.raw).map(async ([k, list]) => {
      const out = [];
      for (const p of list) {
        const ab = await p;
        if (!ab) continue;
        try {
          const b = await new Promise((res, rej) => ctx.decodeAudioData(ab.slice(0), res, rej));
          // loudness match: peak-normalise, and skip leading silence on impacts
          let peak = 0;
          for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); }
          let start = 0;
          if (!CROWD.has(k) && peak > 0) {
            const d = b.getChannelData(0);
            for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak * 0.12) { start = Math.max(0, i / b.sampleRate - 0.006); break; }
          }
          out.push({ b, norm: peak > 0 ? 0.9 / peak : 1, start });
        } catch (e) { /* undecodable: the synth fallback stays */ }
      }
      if (out.length) this.buf[k] = out;
      // swap the synthesised bed for the recorded loop as soon as it's ready
      if (k === 'bed' && out.length) {
        const t = ctx.currentTime;
        this.bed = this.play('bed', { gain: 0, loop: true, bus: this.crowd, raw: true });
        this.bed.g.gain.setTargetAtTime(this.bedLevel(), t, 0.8);
        this.synthBed.gain.setTargetAtTime(0, t, 0.5);
      }
    }));
  }

  // play a decoded sample; returns a handle whose gain can be faded, or null
  play(name, { gain = 1, rate = 1, pan = 0, when = 0, loop = false, bus = null, raw = false, attack = 0 } = {}) {
    const set = this.buf[name];
    if (!this.ctx || !set) return null;
    const ctx = this.ctx, s = pick(set), t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = s.b; src.loop = loop; src.playbackRate.value = rate;
    const g = ctx.createGain();
    const level = raw ? gain : gain * s.norm;
    if (attack > 0) { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(level, t + attack); } else g.gain.value = level;
    let node = src.connect(g);
    if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
    node.connect(bus || this.master);
    src.start(t, loop ? 0 : s.start);
    return { src, g, level };
  }

  fadeOut(h, time = 0.25) {
    if (!h || !this.ctx) return;
    const t = this.ctx.currentTime;
    h.g.gain.cancelScheduledValues(t);
    h.g.gain.setValueAtTime(h.g.gain.value, t);
    h.g.gain.setTargetAtTime(0, t, time / 3);
    try { h.src.stop(t + time + 0.1); } catch (e) { /* already stopped */ }
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.05);
  }

  duck(on) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(on || !this.enabled ? (this.enabled ? 0.15 : 0) : 0.9, this.ctx.currentTime, 0.1);
  }

  get ok() { return this.ctx && this.enabled; }

  _noise(dur, { type = 'bandpass', f = 1000, q = 1, gain = 0.5, attack = 0.005, pan = 0, f2 = null, buf = null, when = 0 } = {}) {
    const ctx = this.ctx, t = ctx.currentTime + when;
    const s = ctx.createBufferSource();
    s.buffer = buf || this.white;
    s.loop = true;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; s.connect(fl).connect(g).connect(p).connect(this.master); } else s.connect(fl).connect(g).connect(this.master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  _tone(freq, dur, { type = 'sine', gain = 0.3, f2 = null, pan = 0, attack = 0.003, when = 0 } = {}) {
    const ctx = this.ctx, t = ctx.currentTime + when;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; o.connect(g).connect(p).connect(this.master); } else o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // ---------- ball ----------
  dribble(v = 1, pan = 0) {
    if (!this.ok) return;
    if (this.play('dribble', { gain: clamp(0.3 + v * 0.22, 0.25, 0.85), rate: 0.94 + Math.random() * 0.12, pan })) return;
    const g = Math.min(0.9, 0.35 + v * 0.1);
    this._tone(115, 0.13, { f2: 55, gain: g, pan });
    this._noise(0.06, { type: 'lowpass', f: 1400, gain: g * 0.5, pan });
    this._noise(0.25, { type: 'bandpass', f: 380, q: 3, gain: g * 0.12, pan, attack: 0.01 });
  }

  rim(v = 1, pan = 0) {
    if (!this.ok) return;
    // the rim is the sound of the game: loud, heavy, never quieter than the crowd
    if (this.play('rim', { gain: clamp(0.5 + v * 0.2, 0.5, 1), rate: 0.94 + Math.random() * 0.1, pan })) return;
    const g = Math.min(0.6, 0.12 + v * 0.07);
    for (const [f, d] of [[512, 0.5], [1187, 0.35], [2010, 0.22], [3120, 0.12]]) this._tone(f, d, { gain: g * (f < 600 ? 1 : 0.5), pan, type: 'triangle' });
    this._noise(0.05, { type: 'highpass', f: 2500, gain: g * 0.6, pan });
  }

  board(v = 1, pan = 0) {
    if (!this.ok) return;
    if (this.play('board', { gain: clamp(0.35 + v * 0.16, 0.3, 0.95), rate: 0.96 + Math.random() * 0.08, pan })) return;
    const g = Math.min(0.7, 0.2 + v * 0.07);
    this._tone(150, 0.16, { f2: 90, gain: g, pan });
    this._noise(0.12, { type: 'bandpass', f: 900, q: 1.2, gain: g * 0.5, pan });
    this._tone(620, 0.25, { gain: g * 0.12, pan, type: 'triangle' });
  }

  swish(clean = true) {
    if (!this.ok) return;
    if (this.play('swish', { gain: clean ? 0.95 : 0.6, rate: 0.97 + Math.random() * 0.06 })) {
      // a touch of bright net hiss on top of the recording
      this._noise(0.35, { type: 'bandpass', f: 3600, f2: 5600, q: 0.8, gain: clean ? 0.16 : 0.1, attack: 0.03 });
      return;
    }
    this._noise(clean ? 0.42 : 0.3, { type: 'bandpass', f: 3200, f2: 5200, q: 0.8, gain: clean ? 0.5 : 0.3, attack: 0.03 });
    this._noise(0.3, { type: 'highpass', f: 6000, gain: 0.12, attack: 0.02, when: 0.05 });
  }

  dunk(pan = 0) {
    if (!this.ok) return;
    if (!this.play('dunk', { gain: 1, pan })) this.rim(3, pan);
  }

  squeak(pan = 0) {
    if (!this.ok) return;
    const f = 2200 + Math.random() * 900;
    this._tone(f, 0.11, { f2: f * 1.25, gain: 0.07, pan, type: 'sine', attack: 0.01 });
    this._tone(f * 2.01, 0.09, { f2: f * 2.4, gain: 0.025, pan, attack: 0.01 });
  }

  step(pan = 0) {
    if (!this.ok) return;
    this._noise(0.05, { type: 'lowpass', f: 500, gain: 0.08, pan });
  }

  // ---------- crowd ----------
  // No single voices: the crowd is the arena murmur (bed) and big cheers (roar).
  // A three going up makes the whole building louder; a miss lets it fall away.
  threeUp(home = true) {
    if (!this.ok) return;
    this.swell = home ? 1 : 0.5;
    this.dip = 0;
    this.excite = Math.min(1.5, this.excite + (home ? 0.35 : 0.15));
  }

  // the noise drops away (a miss, the opponent scoring)
  hush(amount = 0.6) {
    this.swell = 0;
    this.dip = Math.min(1, this.dip + amount);
    this.excite = Math.max(0, this.excite - amount * 0.5);
  }

  // made basket: the home crowd goes wild for you, goes quiet for the opponent
  made(home = true, big = 0.7) {
    if (!this.ok) return;
    this.swell = 0;
    if (!home) { this.hush(0.7); return; }
    const a = this.play('roar', { gain: 1, bus: this.crowd });
    if (!a) { this.cheer(big); return; }
    // a second crowd recording on top, a beat later, for a bigger room
    const set = this.buf.roar;
    if (set.length > 1) {
      const other = set.find((x) => x.b !== a.src.buffer) || set[0];
      const src = this.ctx.createBufferSource(); src.buffer = other.b;
      const g = this.ctx.createGain(); g.gain.value = other.norm * clamp(0.45 + big * 0.35, 0.5, 0.95);
      src.connect(g).connect(this.crowd); src.start(this.ctx.currentTime + 0.14);
    }
    this.excite = Math.min(2.2, this.excite + 1.2 + big * 0.6);
  }

  missed(home = true) {
    if (!this.ok) return;
    this.swell = 0;
    if (home) this.hush(0.6);
    else if (!this.play('roar', { gain: 0.4, bus: this.crowd })) this.cheer(0.4);
  }

  // generic crowd pop (steals, ankle-breakers, blocks); home = the play went your way
  cheer(amount = 1, home = true) {
    if (!this.ok) return;
    if (!home) { this.hush(clamp(amount * 0.5, 0.2, 0.6)); return; }
    if (this.play('roar', { gain: clamp(0.25 + amount * 0.45, 0.3, 1), bus: this.crowd })) { this.excite = Math.min(2, this.excite + amount * 0.6); return; }
    const dur = 1.6 + amount * 1.6;
    this._noise(dur, { type: 'bandpass', f: 900, f2: 1300, q: 0.5, gain: 0.25 + amount * 0.3, attack: 0.18, buf: this.pink });
    this._noise(dur * 0.8, { type: 'bandpass', f: 2600, q: 1.5, gain: 0.05 + amount * 0.08, attack: 0.25, buf: this.pink });
    this.excite = Math.min(1.5, this.excite + amount);
  }

  buzzer() {
    if (!this.ok) return;
    this._tone(233, 1.1, { type: 'sawtooth', gain: 0.22, attack: 0.01 });
    this._tone(466, 1.1, { type: 'square', gain: 0.08, attack: 0.01 });
  }

  whoosh() {
    if (!this.ok) return;
    this._noise(0.25, { type: 'bandpass', f: 600, f2: 1800, q: 1, gain: 0.1, attack: 0.05 });
  }

  bedLevel() {
    const mood = (0.9 + Math.min(1.5, this.excite) * 0.4) * (1 + this.swell * 0.9) * (1 - this.dip * 0.45);
    return mood * (this.buf.bed ? this.buf.bed[0].norm : 1) * 0.5;
  }

  update(dt) {
    if (!this.ctx) return;
    this.excite = Math.max(0, this.excite - dt * 0.3);
    this.swell = Math.max(0, this.swell - dt * 0.15);   // a shot that never resolves still fades
    this.dip = Math.max(0, this.dip - dt * 0.3);
    const t = this.ctx.currentTime;
    if (this.bed) this.bed.g.gain.setTargetAtTime(this.bedLevel(), t, 0.4);
    else this.synthBed.gain.setTargetAtTime((0.16 + this.excite * 0.12) * (1 + this.swell * 0.9) * (1 - this.dip * 0.45), t, 0.3);
    this.crowdLp.frequency.setTargetAtTime(5000 + Math.min(1.5, this.excite + this.swell * 0.5) * 5000, t, 0.3);
  }
}
