// Touch (floating joystick + two buttons) and keyboard input.
export class Input {
  constructor() {
    this.stick = { x: 0, y: 0, mag: 0 };
    this.sprintKey = false;
    this.btn = { a: mk(), b: mk() };
    this.pad = document.getElementById('pad');
    this.stickEl = document.getElementById('stick');
    this.nubEl = document.getElementById('nub');
    this.aEl = document.getElementById('btnA');
    this.bEl = document.getElementById('btnB');
    this.touchId = null;
    this.origin = { x: 0, y: 0 };
    this.keys = new Set();
    this.R = 58;
    this.bind();
    this.parkStick();
  }

  parkStick() {
    const x = 110 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sal')) || 0);
    const y = window.innerHeight - 110;
    this.stickEl.style.left = x + 'px';
    this.stickEl.style.top = y + 'px';
    this.nubEl.style.transform = 'translate(0px, 0px)';
    this.stickEl.classList.add('idle');
  }

  bind() {
    const pad = this.pad;
    pad.addEventListener('pointerdown', (e) => {
      if (e.target === this.aEl || e.target === this.bEl) return;
      if (e.clientX > window.innerWidth * 0.55) return;
      if (this.touchId !== null) return;
      this.touchId = e.pointerId;
      const x = Math.max(70, e.clientX), y = Math.min(window.innerHeight - 70, Math.max(70, e.clientY));
      this.origin = { x, y };
      this.stickEl.style.left = x + 'px';
      this.stickEl.style.top = y + 'px';
      this.stickEl.classList.remove('idle');
      try { pad.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      this.moveStick(e);
      e.preventDefault();
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === this.touchId) { this.moveStick(e); e.preventDefault(); } });
    const end = (e) => {
      if (e.pointerId !== this.touchId) return;
      this.touchId = null;
      this.stick.x = this.stick.y = this.stick.mag = 0;
      this.parkStick();
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);

    const btn = (el, key) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        this.press(key);
      });
      const up = (e) => { e.preventDefault(); this.release(key); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    btn(this.aEl, 'a');
    btn(this.bEl, 'b');

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (k === ' ' || k === 'j') { this.press('a'); e.preventDefault(); }
      if (k === 'k') this.press('b');
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === ' ' || k === 'j') this.release('a');
      if (k === 'k') this.release('b');
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.release('a'); this.release('b'); });
  }

  press(key) {
    const b = this.btn[key];
    if (b.down) return;
    b.down = true; b.pressed = true; b.t = 0;
    (key === 'a' ? this.aEl : this.bEl).classList.add('down');
  }

  release(key) {
    const b = this.btn[key];
    if (!b.down) return;
    b.down = false; b.released = true;
    (key === 'a' ? this.aEl : this.bEl).classList.remove('down');
  }

  moveStick(e) {
    let dx = e.clientX - this.origin.x, dy = e.clientY - this.origin.y;
    const d = Math.hypot(dx, dy);
    if (d > this.R) { dx *= this.R / d; dy *= this.R / d; }
    this.nubEl.style.transform = `translate(${dx}px, ${dy}px)`;
    const m = Math.min(1, d / this.R);
    const dead = 0.12;
    const mm = m < dead ? 0 : (m - dead) / (1 - dead);
    this.stick.x = d > 0 ? (dx / Math.max(d, 1e-6)) * mm : 0;
    this.stick.y = d > 0 ? (dy / Math.max(d, 1e-6)) * mm : 0;
    this.stick.mag = mm;
  }

  // call once per frame
  poll(dt) {
    let kx = 0, ky = 0;
    const k = this.keys;
    if (k.has('a') || k.has('arrowleft')) kx -= 1;
    if (k.has('d') || k.has('arrowright')) kx += 1;
    if (k.has('w') || k.has('arrowup')) ky -= 1;
    if (k.has('s') || k.has('arrowdown')) ky += 1;
    let x = this.stick.x, y = this.stick.y, mag = this.stick.mag;
    if (kx || ky) {
      const l = Math.hypot(kx, ky);
      const sprint = k.has('shift');
      mag = sprint ? 1 : 0.8;
      x = (kx / l) * mag; y = (ky / l) * mag;
    }
    for (const b of Object.values(this.btn)) if (b.down) b.t += dt;
    return { x, y, mag, sprint: mag > 0.93 };
  }

  endFrame() {
    for (const b of Object.values(this.btn)) { b.pressed = false; b.released = false; }
  }

  setLabels(a, b, bOff = false, aOff = false) {
    if (this.aEl.textContent !== a) this.aEl.textContent = a;
    if (this.bEl.textContent !== b) this.bEl.textContent = b;
    this.bEl.classList.toggle('off', bOff);
    this.aEl.classList.toggle('off', aOff);
  }
}

function mk() { return { down: false, pressed: false, released: false, t: 0 }; }
