// Ball (mesh + rigid-sphere physics against floor, rim torus, glass) and a
// verlet-cloth net that reacts to the ball.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { COURT, RIM } from './arena.js';

export const BALL_R = 0.119;
const G = 9.81;
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _c = new THREE.Vector3();

function ballTextures() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const bump = document.createElement('canvas');
  bump.width = W; bump.height = H;
  const bg = bump.getContext('2d');
  const bimg = bg.createImageData(W, H);
  const seamW = 0.028;
  const cz = 1.12;
  for (let y = 0; y < H; y++) {
    const theta = (y / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      const phi = (x / W) * Math.PI * 2;
      const px = -Math.cos(phi) * Math.sin(theta);
      const py = Math.cos(theta);
      const pz = Math.sin(phi) * Math.sin(theta);
      const d1 = Math.abs(py);
      const d2 = Math.abs(px);
      const d3 = Math.abs(Math.hypot(px, py, pz - 1) - cz);
      const d4 = Math.abs(Math.hypot(px, py, pz + 1) - cz);
      const d = Math.min(d1, d2, d3, d4);
      const seam = d < seamW ? 1 - Math.pow(d / seamW, 3) : 0;
      // pebbling
      const peb = (Math.sin(x * 1.9 + Math.sin(y * 1.3) * 2) * Math.sin(y * 2.1 + Math.cos(x * 0.7) * 2) + 1) * 0.5;
      const n = Math.random() * 0.08;
      const i = (y * W + x) * 4;
      const r = 196 - peb * 20 - n * 100, gg = 88 - peb * 12 - n * 40, b = 38 - peb * 6;
      img.data[i] = r * (1 - seam) + 22 * seam;
      img.data[i + 1] = gg * (1 - seam) + 16 * seam;
      img.data[i + 2] = b * (1 - seam) + 14 * seam;
      img.data[i + 3] = 255;
      const bv = seam > 0 ? 40 : 150 + peb * 80 + n * 200;
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = bv;
      bimg.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  bg.putImageData(bimg, 0, 0);
  // printed wordmark on one panel
  g.fillStyle = 'rgba(20,12,8,0.55)';
  g.font = '700 38px "Saira Extra Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'center';
  g.fillText('HOOPS', W * 0.37, H * 0.42);
  g.font = '600 20px "Saira Extra Condensed", "Arial Narrow", sans-serif';
  g.fillText('OFFICIAL GAME BALL', W * 0.37, H * 0.47);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return { map, bump: new THREE.CanvasTexture(bump) };
}

export class Ball {
  constructor(scene) {
    const { map, bump } = ballTextures();
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 48, 32),
      new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 1.2, roughness: 0.66, metalness: 0, envMapIntensity: 0.7 })
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    const bc = document.createElement('canvas');
    bc.width = bc.height = 64;
    const bg = bc.getContext('2d');
    const grd = bg.createRadialGradient(32, 32, 2, 32, 32, 31);
    grd.addColorStop(0, 'rgba(0,0,0,0.8)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    bg.fillStyle = grd;
    bg.fillRect(0, 0, 64, 64);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(bc), transparent: true, depthWrite: false, toneMapped: false }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 1;
    scene.add(this.blob);

    this.pos = new THREE.Vector3(0, 1, 6);
    this.prev = new THREE.Vector3().copy(this.pos);
    this.vel = new THREE.Vector3();
    this.spin = new THREE.Vector3();       // angular velocity (rad/s)
    this.free = false;                     // true when simulated
    this.inNet = 0;
  }

  // one physics substep; pushes events {type, v}
  step(h, events) {
    const p = this.pos, v = this.vel;
    this.prev.copy(p);
    v.y -= G * h;
    v.multiplyScalar(1 - 0.05 * h);
    p.addScaledVector(v, h);

    // rim (torus): nearest point on the ring
    const dx = p.x - RIM.x, dz = p.z - RIM.z;
    const hl = Math.hypot(dx, dz);
    const ringR = COURT.rimR + COURT.rimTube;
    if (Math.abs(p.y - RIM.y) < BALL_R + 0.05 && Math.abs(hl - ringR) < BALL_R + 0.05) {
      const ux = hl > 1e-6 ? dx / hl : 1, uz = hl > 1e-6 ? dz / hl : 0;
      _c.set(RIM.x + ux * ringR, RIM.y, RIM.z + uz * ringR);
      _n.copy(p).sub(_c);
      const d = _n.length();
      const minD = BALL_R + COURT.rimTube;
      if (d < minD && d > 1e-6) {
        _n.divideScalar(d);
        p.addScaledVector(_n, minD - d);
        const vn = v.dot(_n);
        if (vn < 0) {
          _t.copy(v).addScaledVector(_n, -vn);
          v.copy(_t.multiplyScalar(0.8)).addScaledVector(_n, -vn * 0.52);
          events.push({ type: 'rim', v: -vn });
          this.spin.multiplyScalar(0.6);
        }
      }
    }

    // backboard (box)
    const bx0 = -COURT.boardW / 2, bx1 = COURT.boardW / 2;
    const by0 = COURT.boardBottom, by1 = COURT.boardBottom + COURT.boardH;
    const bz0 = COURT.boardZ - 0.03, bz1 = COURT.boardZ;
    _c.set(Math.max(bx0, Math.min(bx1, p.x)), Math.max(by0, Math.min(by1, p.y)), Math.max(bz0, Math.min(bz1, p.z)));
    _n.copy(p).sub(_c);
    let d = _n.length();
    if (d < BALL_R) {
      if (d < 1e-6) { _n.set(0, 0, 1); d = 0; } else _n.divideScalar(d);
      p.addScaledVector(_n, BALL_R - d);
      const vn = v.dot(_n);
      if (vn < 0) {
        _t.copy(v).addScaledVector(_n, -vn);
        v.copy(_t.multiplyScalar(0.85)).addScaledVector(_n, -vn * 0.62);
        events.push({ type: 'board', v: -vn });
      }
    }

    // stanchion arm / shot-clock box: crude block behind the glass
    if (p.z < COURT.boardZ - 0.03 && p.z > -3.2 && p.y > 3.2 && p.y < 4.2 && Math.abs(p.x) < 0.5) {
      v.z = Math.abs(v.z) * 0.4; v.y *= 0.5;
    }

    // net drag
    if (p.y < RIM.y && p.y > RIM.y - 0.48 && hl < COURT.rimR) {
      const drag = Math.pow(0.02, h);
      v.x *= drag; v.z *= drag; v.y *= Math.pow(0.35, h);
      this.inNet = 0.25;
    }

    // floor
    if (p.y < BALL_R) {
      p.y = BALL_R;
      if (v.y < -0.35) {
        events.push({ type: 'floor', v: -v.y });
        v.y = -v.y * 0.76;
      } else v.y = 0;
      v.x *= 0.93; v.z *= 0.93;
      // rolling
      this.spin.set(v.z / BALL_R, 0, -v.x / BALL_R);
      if (Math.hypot(v.x, v.z) < 0.05 && Math.abs(v.y) < 0.05) { v.x = v.z = 0; }
    }

    // arena walls (keep the ball in the building)
    if (Math.abs(p.x) > 9.2) { p.x = Math.sign(p.x) * 9.2; v.x *= -0.4; }
    if (p.z < -3.0) { p.z = -3.0; v.z *= -0.4; }
    if (p.z > 18) { p.z = 18; v.z *= -0.4; }
  }

  // visual update
  sync(dt) {
    const m = this.mesh;
    m.position.copy(this.pos);
    const w = this.spin.length();
    if (w > 1e-3) {
      _n.copy(this.spin).divideScalar(w);
      m.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(_n, w * dt));
    }
    const hgt = Math.max(0, this.pos.y - BALL_R);
    const s = 0.34 + hgt * 0.12;
    this.blob.position.set(this.pos.x, 0.005, this.pos.z);
    this.blob.scale.set(s, s, 1);
    this.blob.material.opacity = Math.max(0, 0.7 - hgt * 0.2);
    this.inNet = Math.max(0, this.inNet - dt);
  }
}

// ---------------- net ----------------
export class Net {
  constructor(scene, resolution) {
    this.N = 12;
    this.R = 6;
    const N = this.N, R = this.R;
    this.p = [];
    this.pp = [];
    this.pin = [];
    for (let r = 0; r < R; r++) {
      const f = r / (R - 1);
      const rad = COURT.rimR - (COURT.rimR - 0.125) * Math.pow(f, 0.85);
      const y = RIM.y - r * 0.083;
      for (let i = 0; i < N; i++) {
        const a = ((i + 0.5 * (r % 2)) / N) * Math.PI * 2;
        const v = new THREE.Vector3(RIM.x + Math.cos(a) * rad, y, RIM.z + Math.sin(a) * rad);
        this.p.push(v);
        this.pp.push(v.clone());
        this.pin.push(r === 0);
      }
    }
    const idx = (r, i) => r * N + ((i % N) + N) % N;
    this.c = [];
    for (let r = 0; r < R - 1; r++) {
      for (let i = 0; i < N; i++) {
        const a = idx(r, i);
        const b1 = idx(r + 1, i);
        const b2 = idx(r + 1, r % 2 === 0 ? i - 1 : i + 1);
        this.c.push([a, b1, this.p[a].distanceTo(this.p[b1])]);
        this.c.push([a, b2, this.p[a].distanceTo(this.p[b2])]);
      }
    }
    for (let i = 0; i < N; i++) {
      const a = idx(R - 1, i), b = idx(R - 1, i + 1);
      this.c.push([a, b, this.p[a].distanceTo(this.p[b]) * 1.04, true]);
    }
    this.geo = new LineSegmentsGeometry();
    this.buf = new Float32Array(this.c.length * 6);
    this.writeBuf();
    this.geo.setPositions(this.buf);
    this.mat = new LineMaterial({ color: 0xf2f2f2, linewidth: 1.6, transparent: true, opacity: 0.95, worldUnits: false });
    this.mat.resolution.copy(resolution);
    this.lines = new LineSegments2(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
    scene.add(this.lines);
    this.energy = 0;
  }

  writeBuf() {
    let k = 0;
    for (const [a, b, , ring] of this.c) {
      if (ring) { // draw the bottom ring very faintly: repeat point to hide it
        const pa = this.p[a];
        this.buf[k++] = pa.x; this.buf[k++] = pa.y; this.buf[k++] = pa.z;
        this.buf[k++] = pa.x; this.buf[k++] = pa.y; this.buf[k++] = pa.z;
        continue;
      }
      const pa = this.p[a], pb = this.p[b];
      this.buf[k++] = pa.x; this.buf[k++] = pa.y; this.buf[k++] = pa.z;
      this.buf[k++] = pb.x; this.buf[k++] = pb.y; this.buf[k++] = pb.z;
    }
  }

  update(dt, ball) {
    const steps = 2;
    const h = Math.min(dt, 1 / 30) / steps;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.p.length; i++) {
        if (this.pin[i]) continue;
        const p = this.p[i], pp = this.pp[i];
        const vx = (p.x - pp.x) * 0.965, vy = (p.y - pp.y) * 0.965, vz = (p.z - pp.z) * 0.965;
        pp.copy(p);
        p.x += vx; p.y += vy - G * h * h; p.z += vz;
      }
      for (let it = 0; it < 4; it++) {
        for (const [a, b, rest] of this.c) {
          const pa = this.p[a], pb = this.p[b];
          _t.subVectors(pb, pa);
          const d = _t.length() || 1e-6;
          if (d > rest) { // strings only resist stretch, so the net can bunch up

            const diff = (d - rest) / d;
            const wa = this.pin[a] ? 0 : 1, wb = this.pin[b] ? 0 : 1;
            const tw = wa + wb || 1;
            pa.addScaledVector(_t, diff * wa / tw);
            pb.addScaledVector(_t, -diff * wb / tw);
          }
        }
        // ball pushes the mesh
        if (ball) {
          const bp = ball.pos, rr = BALL_R + 0.012;
          if (Math.abs(bp.y - (RIM.y - 0.2)) < 0.5 && Math.hypot(bp.x - RIM.x, bp.z - RIM.z) < 0.45) {
            for (let i = 0; i < this.p.length; i++) {
              if (this.pin[i]) continue;
              const p = this.p[i];
              _t.subVectors(p, bp);
              const d = _t.length();
              if (d < rr && d > 1e-6) p.addScaledVector(_t, (rr - d) / d);
            }
          }
        }
      }
    }
    this.writeBuf();
    const attr = this.geo.attributes.instanceStart;
    attr.data.array.set(this.buf);
    attr.data.needsUpdate = true;
  }
}
