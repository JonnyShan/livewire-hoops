// The crowd: a tiered bowl of seats wrapped around the half court, filled with
// photographed fans (img/fans.webp, one seated and one cheering frame each).
// Every fan is one instanced card; the vertex shader stands them up, bounces
// them and sways them, so ~2,500 fans cost a single draw call.
import * as THREE from 'three';

// atlas layout (see raw/hardwood/gfx/fans_atlas.py)
const ATLAS = { url: 'img/fans.webp', cols: 10, rows: 8, cardW: 1.2352, cardH: 1.55, headY: 0.3875, fans: 40, standers: 16 };
const SEAT_HEAD = 1.22, STAND_HEAD = 1.68;   // head-top height above the row's floor (m)

// seating bowl: a rounded rectangle around the half court; row i sits i*DEPTH
// further out and i*RISE higher
export const BOWL = { xs: 10.4, zb: -5.4, rc: 3.2, zEnd: 22, rows: 16, depth: 0.82, rise: 0.44, y0: 0.42, seat: 0.58 };

// point + inward normal at arc length s along row offset `off`
function pathPoints(off, step) {
  const B = BOWL, out = [];
  const X = B.xs - B.rc, Zc = B.zb + B.rc, R = B.rc + off;
  const push = (x, z, nx, nz, seg) => out.push({ x, z, nx, nz, seg });
  // left sideline (from behind the camera toward the baseline), corner, baseline, corner, right sideline
  for (let z = B.zEnd; z > Zc; z -= step) push(-(B.xs + off), z, 1, 0, 'side');
  for (let a = 0; a < Math.PI / 2; a += step / R) push(-X - Math.cos(a) * R, Zc - Math.sin(a) * R, Math.cos(a), Math.sin(a), 'corner');
  for (let x = -X; x < X; x += step) push(x, B.zb - off, 0, 1, 'base');
  for (let a = Math.PI / 2; a > 0; a -= step / R) push(X + Math.cos(a) * R, Zc - Math.sin(a) * R, -Math.cos(a), Math.sin(a), 'corner');
  for (let z = Zc; z <= B.zEnd; z += step) push(B.xs + off, z, -1, 0, 'side');
  return out;
}

// aisles: radial stairways that stay put from row to row
function inAisle(p) {
  if (p.seg === 'base') return Math.abs(Math.abs(p.x) - 4.6) < 0.45;
  if (p.seg === 'side') return [3.2, 11.4, 19.6].some((z) => Math.abs(p.z - z) < 0.45);
  return Math.abs(Math.abs(Math.atan2(p.nz, Math.abs(p.nx))) - Math.PI / 4) < 0.05;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const vert = /* glsl */`
  attribute vec3 iPos;
  attribute float iYaw;
  attribute float iFan;
  attribute vec4 iRnd;
  attribute float iShade;
  uniform float uTime, uCheer, uBounce;
  uniform vec3 uCam;
  uniform vec4 uCard;        // cardW, cardH, headY, cols
  uniform vec4 uGrid;        // cols, rows, standing head lift, fans who get to their feet
  varying vec2 vUv;
  varying float vShade;
  void main() {
    // each fan has their own trigger point, so the crowd ripples to its feet
    float stand = smoothstep(iRnd.x * 0.85, iRnd.x * 0.85 + 0.12, uCheer);
    float up = step(0.5, stand);
    // face the court, turned part of the way toward the camera
    vec3 toCam = uCam - iPos;
    float d = atan(toCam.x, toCam.z) - iYaw;
    float yaw = iYaw + atan(sin(d), cos(d)) * 0.55;
    float t = uTime + iRnd.y * 40.0;
    float hop = up * max(0.0, sin(t * (6.5 + iRnd.z * 4.0))) * 0.11 * uBounce;
    float sway = sin(t * 0.8) * 0.012 + up * sin(t * 2.9) * 0.035 * (0.4 + uBounce);
    float lean = up * sin(t * 2.2 + iRnd.w * 6.28) * 0.05 * (0.4 + uBounce);
    // card: x in [-0.5, 0.5], y in [0, 1]; its top sits headY above the head
    vec2 p = vec2(position.x * uCard.x, position.y * uCard.y);
    // the first fans in the atlas jump to their feet; the rest cheer from their seats
    float head = mix(0.0, iFan < uGrid.w ? uGrid.z : 0.03, stand);
    float top = head + uCard.z;
    float cr = cos(lean), sr = sin(lean);
    vec2 q = vec2(p.x, p.y - uCard.y + uCard.z);            // rotate about the head
    q = vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);
    p = vec2(q.x, q.y + uCard.y - uCard.z);
    p.x += sway;
    p.y += top - uCard.y + hop;
    vec3 right = vec3(cos(yaw), 0.0, -sin(yaw));
    vec3 world = iPos + right * p.x + vec3(0.0, p.y, 0.0);
    // atlas cell: seated = 2 * fan, cheering = 2 * fan + 1 (mirrored for half the crowd)
    float slot = iFan * 2.0 + up;
    float col = mod(slot, uGrid.x), row = floor(slot / uGrid.x);
    vec2 u = uv;
    if (iRnd.w > 0.5) u.x = 1.0 - u.x;
    vUv = vec2((col + u.x) / uGrid.x, 1.0 - (row + 1.0 - u.y) / uGrid.y);
    vShade = iShade;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }`;

const frag = /* glsl */`
  uniform sampler2D uMap;
  uniform float uLight;
  varying vec2 vUv;
  varying float vShade;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    if (c.a < 0.5) discard;
    gl_FragColor = vec4(c.rgb * vShade * uLight, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function buildCrowd(group, { quality = 'med', ledTex = null } = {}) {
  const B = BOWL;
  const rand = rng(1234);

  // ---- the bowl: risers and treads ----
  const pos = [], idx = [];
  const quad = (a, b, c, d) => { const n = pos.length / 3; pos.push(...a, ...b, ...c, ...d); idx.push(n, n + 1, n + 2, n, n + 2, n + 3); };
  for (let i = 0; i <= B.rows; i++) {
    const off = i * B.depth, y = B.y0 + i * B.rise, yPrev = i ? y - B.rise : 0;
    const P = pathPoints(off, 0.8), Q = pathPoints(off + B.depth, 0.8);
    for (let k = 0; k < P.length - 1; k++) {
      const a = P[k], b = P[k + 1];
      if (Math.hypot(b.x - a.x, b.z - a.z) > 2) continue;
      quad([a.x, yPrev, a.z], [b.x, yPrev, b.z], [b.x, y, b.z], [a.x, y, a.z]);               // riser
      const a2 = { x: a.x - a.nx * B.depth, z: a.z - a.nz * B.depth }, b2 = { x: b.x - b.nx * B.depth, z: b.z - b.nz * B.depth };
      if (i < B.rows) quad([a.x, y, a.z], [a2.x, y, a2.z], [b2.x, y, b2.z], [b.x, y, b.z]);  // tread
    }
    void Q;
  }
  const bowlGeo = new THREE.BufferGeometry();
  bowlGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bowlGeo.setIndex(idx);
  bowlGeo.computeVertexNormals();
  const bowl = new THREE.Mesh(bowlGeo, new THREE.MeshStandardMaterial({ color: '#141519', roughness: 0.92, side: THREE.DoubleSide, envMapIntensity: 0.25 }));
  group.add(bowl);

  // front wall at courtside and the LED fascia running round the top of the bowl
  const strip = (off, y0, h, mat, lean = 0) => {
    const P = pathPoints(off, 0.5), p = [], uv = [], ix = [];
    let s = 0;
    for (let k = 0; k < P.length; k++) {
      const a = P[k];
      if (k) s += Math.hypot(a.x - P[k - 1].x, a.z - P[k - 1].z);
      p.push(a.x, y0, a.z, a.x - a.nx * lean, y0 + h, a.z - a.nz * lean);
      uv.push(s / 16, 0, s / 16, 1);
      if (k) { const n = k * 2; ix.push(n - 2, n, n + 1, n - 2, n + 1, n - 1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(ix);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    group.add(m);
    return m;
  };
  strip(-0.02, 0, B.y0 + 0.62, new THREE.MeshStandardMaterial({ color: '#0d0e11', roughness: 0.8, side: THREE.DoubleSide }));
  const topOff = B.rows * B.depth + 0.1, topY = B.y0 + B.rows * B.rise;
  strip(topOff, topY - B.rise, 0.5 + B.rise, new THREE.MeshStandardMaterial({ color: '#0b0c0f', roughness: 0.9, side: THREE.DoubleSide }));
  let fascia = null;
  if (ledTex) {
    const t = ledTex.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.needsUpdate = true;
    fascia = strip(topOff, topY + 0.5, 1.0, new THREE.MeshBasicMaterial({ map: t, toneMapped: false, color: '#bdbdbd', side: THREE.DoubleSide }), 0.15);
  }

  // ---- fans ----
  const seats = [];
  for (let i = 0; i < B.rows; i++) {
    const off = i * B.depth + 0.34, y = B.y0 + i * B.rise;
    const P = pathPoints(off, B.seat);
    for (const p of P) {
      if (inAisle(p)) continue;
      if (rand() < 0.035) continue;                         // the odd empty seat
      const j = (rand() - 0.5) * 0.08;
      seats.push({ x: p.x - p.nz * j, y, z: p.z + p.nx * j, yaw: Math.atan2(p.nx, p.nz), row: i });
    }
  }
  const n = seats.length;
  const base = new THREE.PlaneGeometry(1, 1);
  base.translate(0, 0.5, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const iPos = new Float32Array(n * 3), iYaw = new Float32Array(n), iFan = new Float32Array(n), iRnd = new Float32Array(n * 4), iShade = new Float32Array(n);
  seats.forEach((s, k) => {
    iPos.set([s.x, s.y + SEAT_HEAD, s.z], k * 3);
    iYaw[k] = s.yaw;
    iFan[k] = Math.floor(rand() * ATLAS.fans);
    iRnd.set([rand(), rand(), rand(), rand()], k * 4);
    // the court lights spill onto the front rows; the upper rows fall into shadow
    const dCourt = Math.hypot(s.x * 0.8, s.z - 5);
    iShade[k] = (0.92 - 0.55 * (s.row / B.rows)) * (1.1 - Math.min(0.35, Math.max(0, dCourt - 11) * 0.02)) * (0.82 + rand() * 0.3);
  });
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
  geo.setAttribute('iYaw', new THREE.InstancedBufferAttribute(iYaw, 1));
  geo.setAttribute('iFan', new THREE.InstancedBufferAttribute(iFan, 1));
  geo.setAttribute('iRnd', new THREE.InstancedBufferAttribute(iRnd, 4));
  geo.setAttribute('iShade', new THREE.InstancedBufferAttribute(iShade, 1));
  geo.instanceCount = n;

  const tex = new THREE.TextureLoader().load(ATLAS.url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const uniforms = {
    uMap: { value: tex }, uTime: { value: 0 }, uCheer: { value: 0 }, uBounce: { value: 0 }, uLight: { value: 0.345 },
    uCam: { value: new THREE.Vector3() },
    uCard: { value: new THREE.Vector4(ATLAS.cardW, ATLAS.cardH, ATLAS.headY, ATLAS.cols) },
    uGrid: { value: new THREE.Vector4(ATLAS.cols, ATLAS.rows, STAND_HEAD - SEAT_HEAD, ATLAS.standers - 0.5) },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide });
  const fans = new THREE.Mesh(geo, mat);
  fans.frustumCulled = false;
  group.add(fans);

  // camera flashes in the crowd
  const flashN = quality === 'low' ? 40 : 110;
  const flashPos = new Float32Array(flashN * 3), flashCol = new Float32Array(flashN * 3);
  for (let i = 0; i < flashN; i++) {
    const s = seats[Math.floor(rand() * n)];
    flashPos.set([s.x, s.y + SEAT_HEAD - 0.1, s.z], i * 3);
  }
  const flashGeo = new THREE.BufferGeometry();
  flashGeo.setAttribute('position', new THREE.BufferAttribute(flashPos, 3));
  flashGeo.setAttribute('color', new THREE.BufferAttribute(flashCol, 3));
  const flashes = new THREE.Points(flashGeo, new THREE.PointsMaterial({
    size: 0.3, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
  }));
  group.add(flashes);

  // ---- mood ----
  // cheer: how much of the crowd is on its feet (0-1); bounce: how hard they jump
  const st = { t: 0, cheer: 0, target: 0, hold: 0, bounce: 0, excite: 0 };
  return {
    count: n,
    // a three goes up: the home crowd starts to rise
    rise(home = true) { if (home) { st.target = Math.max(st.target, 0.35); st.hold = 2.5; st.bounce = Math.max(st.bounce, 0.15); } },
    // home = the play went the home crowd's way
    cheer(amount = 1, home = true) {
      st.excite = Math.min(1.5, st.excite + amount);
      if (!home) { st.target = 0; st.hold = 0; return; }
      st.target = Math.min(1, 0.45 + amount * 0.45);
      st.hold = 1.6 + amount * 2;
      st.bounce = Math.min(1.2, st.bounce + 0.4 + amount * 0.5);
    },
    settle() { st.target = 0; st.hold = 0; },
    update(dt, camera) {
      st.t += dt;
      st.hold = Math.max(0, st.hold - dt);
      if (st.hold === 0) st.target = Math.max(0, st.target - dt * 0.35);
      st.cheer += (st.target - st.cheer) * (1 - Math.exp(-dt * (st.target > st.cheer ? 7 : 2.2)));
      st.bounce = Math.max(0, st.bounce - dt * 0.25);
      st.excite = Math.max(0, st.excite - dt * 0.35);
      uniforms.uTime.value = st.t;
      uniforms.uCheer.value = st.cheer;
      uniforms.uBounce.value = Math.min(1, st.bounce);
      if (camera) uniforms.uCam.value.copy(camera.position);
      if (fascia) fascia.material.map.offset.x = (st.t * 0.03) % 1;
      const rate = 0.003 + st.excite * 0.05;
      for (let i = 0; i < flashN; i++) {
        const k = i * 3;
        let v = flashCol[k] * Math.exp(-dt * 16);
        if (Math.random() < rate) v = 0.9 + Math.random() * 0.6;
        flashCol[k] = flashCol[k + 1] = flashCol[k + 2] = v;
      }
      flashGeo.attributes.color.needsUpdate = true;
    },
    get state() { return st; },
    uniforms,
  };
}
