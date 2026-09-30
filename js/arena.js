// Arena: hardwood floor + markings, glossy reflections, the crowd (crowd.js),
// LED boards, hoop (stanchion, glass, rim, shot clock). Units are metres.
// Court frame: baseline at z = 0, half-court line at z = 14.33, x = lateral.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BRAND } from './data.js';
import { buildCrowd } from './crowd.js';

export const COURT = {
  halfW: 7.62,           // sideline x
  halfLen: 14.33,        // half-court line z
  rimY: 3.048,
  rimZ: 1.575,
  rimR: 0.2286,          // inner radius
  rimTube: 0.009,
  boardZ: 1.22,          // backboard front face
  boardW: 1.83,
  boardBottom: 2.90,
  boardH: 1.067,
  threeR: 7.24,
  cornerX: 6.71,
  cornerZ: 4.295,
  keyW: 4.88,
  ftZ: 5.79,
};
export const RIM = new THREE.Vector3(0, COURT.rimY, COURT.rimZ);

export function isThree(x, z) {
  const dx = x, dz = z - COURT.rimZ;
  if (z < COURT.cornerZ) return Math.abs(x) > COURT.cornerX;
  return Math.hypot(dx, dz) > COURT.threeR;
}

const loader = new THREE.TextureLoader();
function tex(url, srgb = true) {
  const t = loader.load(url);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function loadImage(url) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  });
}

// ---------- floor reflection (additive, blurred, fresnel-weighted) ----------
const ReflectShader = {
  name: 'FloorReflect',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    strength: { value: 0.24 },
    texel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform vec2 texel;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec2 uv = vUv.xy / vUv.w;
      vec3 c = texture2D(tDiffuse, uv).rgb * 0.30;
      c += texture2D(tDiffuse, uv + vec2(texel.x * 2.5, 0.0)).rgb * 0.175;
      c += texture2D(tDiffuse, uv - vec2(texel.x * 2.5, 0.0)).rgb * 0.175;
      c += texture2D(tDiffuse, uv + vec2(0.0, texel.y * 3.5)).rgb * 0.175;
      c += texture2D(tDiffuse, uv - vec2(0.0, texel.y * 3.5)).rgb * 0.175;
      // guard against NaN/Inf texels some GPUs leave in half-float targets
      if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
      c = min(c, vec3(0.85));
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = 0.28 + 0.72 * pow(1.0 - clamp(V.y, 0.0, 1.0), 2.5);
      gl_FragColor = vec4(c * strength * fres, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

// draw the Livewire wordmark centred at (cx, cy), h pixels tall
let _wm = null;
function drawWordmark(ctx, cx, cy, h, color) {
  const W = BRAND.wordmark;
  if (!_wm) _wm = new Path2D(W.d);
  const sc = h / W.h;
  ctx.save();
  ctx.translate(cx - (W.w * sc) / 2, cy - h / 2);
  ctx.scale(sc, sc);
  ctx.fillStyle = color;
  ctx.fill(_wm);
  ctx.restore();
}

// ---------- court markings canvas ----------
const MK = { x0: -9, z0: -2.5, size: 18, px: 2048 };
function drawCourt(ctx, home, logoImg) {
  const k = MK.px / MK.size;
  const X = (x) => (x - MK.x0) * k;
  const Z = (z) => (z - MK.z0) * k;
  ctx.clearRect(0, 0, MK.px, MK.px);

  // apron (outside the lines) stained in the home team's dark colour
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = home.secondary;
  ctx.fillRect(0, 0, MK.px, Z(0));
  ctx.fillRect(0, 0, X(-COURT.halfW), MK.px);
  ctx.fillRect(X(COURT.halfW), 0, MK.px, MK.px);
  ctx.globalAlpha = 1;

  // painted key (a branded home team paints it in its dark colour)
  ctx.globalAlpha = home.brand ? 0.92 : 0.86;
  ctx.fillStyle = home.brand ? home.secondary : home.primary;
  ctx.fillRect(X(-COURT.keyW / 2), Z(0), COURT.keyW * k, COURT.ftZ * k);
  ctx.globalAlpha = 1;

  // center-court circle + logo
  ctx.save();
  ctx.beginPath();
  ctx.arc(X(0), Z(COURT.halfLen), 1.83 * k, 0, Math.PI * 2);
  ctx.globalAlpha = home.brand ? 0.94 : 0.85;
  ctx.fillStyle = home.brand ? home.secondary : home.primary;
  ctx.fill();
  ctx.globalAlpha = 1;
  if (logoImg) {
    // fit inside the circle, keeping the image's own proportions
    const s = (home.brand ? 2.3 : 3.1) * k, ar = logoImg.width / logoImg.height || 1;
    const w = ar >= 1 ? s : s * ar, h = ar >= 1 ? s / ar : s;
    ctx.drawImage(logoImg, X(0) - w / 2, Z(COURT.halfLen) - h / 2, w, h);
  }
  ctx.restore();

  // baseline apron wordmark
  if (home.brand) {
    for (const x of [-4.4, 4.4]) drawWordmark(ctx, X(x), Z(-1.25), 0.85 * k, BRAND.yellow);
  } else {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `900 ${Math.round(1.25 * k)}px "Saira Extra Condensed", "Arial Narrow", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(home.city.toUpperCase(), X(-4.4), Z(-1.25));
    ctx.fillText(home.name.toUpperCase(), X(4.4), Z(-1.25));
    ctx.restore();
  }

  // sideline wordmarks (read from the court)
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(X(side * 8.3), Z(7));
    ctx.rotate(side * Math.PI / 2);
    drawWordmark(ctx, 0, 0, 0.5 * k, 'rgba(203,254,0,0.9)');
    ctx.restore();
  }

  // lines
  ctx.strokeStyle = 'rgba(255,255,255,0.96)';
  ctx.lineWidth = 0.055 * k;
  ctx.lineCap = 'butt';
  const line = (x1, z1, x2, z2) => { ctx.beginPath(); ctx.moveTo(X(x1), Z(z1)); ctx.lineTo(X(x2), Z(z2)); ctx.stroke(); };
  line(-COURT.halfW, 0, COURT.halfW, 0);                                   // baseline
  line(-COURT.halfW, 0, -COURT.halfW, 16);                                 // sidelines
  line(COURT.halfW, 0, COURT.halfW, 16);
  line(-COURT.halfW, COURT.halfLen, COURT.halfW, COURT.halfLen);           // half-court
  // key
  ctx.strokeRect(X(-COURT.keyW / 2), Z(0), COURT.keyW * k, COURT.ftZ * k);
  // FT circle: solid outside, dashed inside the key
  ctx.beginPath(); ctx.arc(X(0), Z(COURT.ftZ), 1.83 * k, 0, Math.PI); ctx.stroke();
  ctx.save(); ctx.setLineDash([0.38 * k, 0.3 * k]);
  ctx.beginPath(); ctx.arc(X(0), Z(COURT.ftZ), 1.83 * k, Math.PI, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // restricted area
  ctx.beginPath(); ctx.arc(X(0), Z(COURT.rimZ), 1.22 * k, 0, Math.PI); ctx.stroke();
  line(-1.22, COURT.rimZ, -1.22, COURT.boardZ);
  line(1.22, COURT.rimZ, 1.22, COURT.boardZ);
  // three-point line
  const a = Math.atan2(COURT.cornerZ - COURT.rimZ, COURT.cornerX);
  line(-COURT.cornerX, 0, -COURT.cornerX, COURT.cornerZ);
  line(COURT.cornerX, 0, COURT.cornerX, COURT.cornerZ);
  ctx.beginPath(); ctx.arc(X(0), Z(COURT.rimZ), COURT.threeR * k, a, Math.PI - a); ctx.stroke();
  // lane hash marks
  for (const z of [2.13, 2.44, 3.35, 4.27]) {
    const w = z === 2.44 ? 0.3 : 0.05;
    for (const s of [-1, 1]) {
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.fillRect(X(s * COURT.keyW / 2) + (s > 0 ? 0 : -0.15 * k), Z(z), 0.15 * k, w * k);
    }
  }
  // center circle outline
  ctx.beginPath(); ctx.arc(X(0), Z(COURT.halfLen), 1.83 * k, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(X(0), Z(COURT.halfLen), 0.61 * k, 0, Math.PI * 2); ctx.stroke();
  // backboard shadow line under the board (subtle)
}

// ---------- LED ribbon board ----------
function makeLed(w, h, home, away, pxW = 2048) {
  const c = document.createElement('canvas');
  c.width = pxW; c.height = Math.round(pxW * h / w);
  const g = c.getContext('2d');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  const teamName = (t) => (t.city ? t.city + ' ' : '') + t.name;
  const msgs = [
    [home.brand ? BRAND : teamName(home).toUpperCase(), home.brand ? BRAND.yellow : home.primary],
    ['1 ON 1 · HALF COURT', '#ffffff'],
    away.brand ? ['HOOPS', '#ffffff'] : [teamName(away).toUpperCase(), away.primary],
    [BRAND, BRAND.yellow],
  ];
  const draw = (hot = 0) => {
    g.fillStyle = '#05060a';
    g.fillRect(0, 0, c.width, c.height);
    const seg = c.width / msgs.length;
    g.font = `800 ${Math.round(c.height * 0.62)}px "Saira Extra Condensed", "Arial Narrow", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    msgs.forEach(([txt, col], i) => {
      const cx = seg * i + seg / 2;
      const grd = g.createLinearGradient(seg * i, 0, seg * (i + 1), 0);
      grd.addColorStop(0, 'rgba(255,255,255,0.02)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0.08)');
      grd.addColorStop(1, 'rgba(255,255,255,0.02)');
      g.fillStyle = grd;
      g.fillRect(seg * i, 0, seg, c.height);
      if (txt === BRAND) drawWordmark(g, cx, c.height * 0.52, c.height * 0.5, hot ? '#ffffff' : col);
      else {
        g.fillStyle = hot ? '#ffffff' : col;
        g.fillText(txt, cx, c.height * 0.54);
      }
    });
    // LED pixel grid
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let y = 0; y < c.height; y += 4) g.fillRect(0, y, c.width, 1);
    t.needsUpdate = true;
  };
  draw();
  return { tex: t, draw };
}

// ---------- shot clock display ----------
function makeClockFace() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  let last = '';
  const draw = (val, red = true) => {
    const s = String(val);
    if (s === last) return;
    last = s;
    g.fillStyle = '#07080a';
    g.fillRect(0, 0, 256, 128);
    g.font = '700 104px "Saira Extra Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,40,30,0.12)';
    g.fillText('88', 128, 68);
    g.fillStyle = red ? '#ff2d1f' : '#ffd23f';
    g.shadowColor = red ? '#ff2d1f' : '#ffd23f';
    g.shadowBlur = 14;
    g.fillText(s, 128, 68);
    g.shadowBlur = 0;
    t.needsUpdate = true;
  };
  draw('12');
  return { tex: t, draw };
}

export async function buildArena(scene, renderer, { home, away, quality }) {
  const group = new THREE.Group();
  scene.add(group);
  scene.background = new THREE.Color('#040507');
  scene.fog = new THREE.Fog('#0a0b0e', 34, 80);

  // lights
  const hemi = new THREE.HemisphereLight('#ffe9d0', '#140e0a', 0.32);
  group.add(hemi);
  const key = new THREE.DirectionalLight('#fff0dc', 2.25);
  key.position.set(3.5, 17, 11);
  key.target.position.set(0, 0, 6);
  key.castShadow = quality !== 'low';
  const sm = quality === 'high' ? 2048 : 1024;
  key.shadow.mapSize.set(sm, sm);
  Object.assign(key.shadow.camera, { left: -10, right: 10, top: 12, bottom: -10, near: 4, far: 40 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  group.add(key, key.target);
  const fill = new THREE.DirectionalLight('#dfe8ff', 0.18);
  fill.position.set(-6, 10, -4);
  group.add(fill);
  // warm pools of light over the court
  const spotA = new THREE.SpotLight('#ffe7c4', 30, 30, 0.46, 0.75, 1.6);
  spotA.position.set(0, 13, 4);
  spotA.target.position.set(0, 0, 4);
  group.add(spotA, spotA.target);

  // dark arena floor beyond the court
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 90),
    new THREE.MeshStandardMaterial({ color: '#0c0c0f', roughness: 0.9 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.01, 8);
  ground.receiveShadow = true;
  group.add(ground);

  // hardwood
  const woodTex = tex('img/floor.jpg');
  woodTex.wrapS = woodTex.wrapT = THREE.MirroredRepeatWrapping;
  const woodW = 18, woodL = 34;
  woodTex.repeat.set(woodW / 1.7, woodL / 1.7);
  woodTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const wood = new THREE.Mesh(
    new THREE.PlaneGeometry(woodW, woodL),
    new THREE.MeshStandardMaterial({ map: woodTex, color: '#d6b690', roughness: 0.32, metalness: 0.0, envMapIntensity: 0.25 })
  );
  wood.rotation.x = -Math.PI / 2;
  wood.position.set(0, 0, MK.z0 + woodL / 2);
  wood.receiveShadow = true;
  group.add(wood);

  // markings
  const mkCanvas = document.createElement('canvas');
  mkCanvas.width = mkCanvas.height = MK.px;
  const logoImg = await loadImage(home.brand ? 'img/livewire-mark.png' : home.logo);
  try { await document.fonts.load('900 40px "Saira Extra Condensed"'); } catch (e) { /* fallback font */ }
  drawCourt(mkCanvas.getContext('2d'), home, logoImg);
  const mkTex = new THREE.CanvasTexture(mkCanvas);
  mkTex.colorSpace = THREE.SRGBColorSpace;
  mkTex.anisotropy = woodTex.anisotropy;
  const markings = new THREE.Mesh(
    new THREE.PlaneGeometry(MK.size, MK.size),
    new THREE.MeshStandardMaterial({ map: mkTex, transparent: true, roughness: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, envMapIntensity: 0.25 })
  );
  markings.rotation.x = -Math.PI / 2;
  markings.position.set(0, 0.001, MK.z0 + MK.size / 2);
  markings.receiveShadow = true;
  group.add(markings);

  // glossy floor reflection
  let reflector = null;
  if (quality !== 'low') {
    const scale = quality === 'high' ? 0.6 : 0.4;
    const w = Math.round(window.innerWidth * Math.min(2, window.devicePixelRatio) * scale);
    const h = Math.round(window.innerHeight * Math.min(2, window.devicePixelRatio) * scale);
    reflector = new Reflector(new THREE.PlaneGeometry(20, 24), {
      textureWidth: w, textureHeight: h, clipBias: 0.003, shader: ReflectShader, multisample: 0,
    });
    reflector.material.transparent = true;
    reflector.material.blending = THREE.AdditiveBlending;
    reflector.material.depthWrite = false;
    reflector.material.uniforms.texel.value.set(1 / w, 1 / h);
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.set(0, 0.002, 7);
    reflector.renderOrder = 2;
    group.add(reflector);
  }

  // LED boards
  const leds = [];
  const ledMat = (t) => new THREE.MeshBasicMaterial({ map: t, toneMapped: false, color: '#d8d8d8' });
  const base = makeLed(14, 0.9, home, away);
  leds.push(base);
  const baseBoard = new THREE.Mesh(new THREE.BoxGeometry(15, 0.9, 0.12), [
    new THREE.MeshStandardMaterial({ color: '#0a0a0c' }), new THREE.MeshStandardMaterial({ color: '#0a0a0c' }),
    new THREE.MeshStandardMaterial({ color: '#0a0a0c' }), new THREE.MeshStandardMaterial({ color: '#0a0a0c' }),
    ledMat(base.tex), new THREE.MeshStandardMaterial({ color: '#0a0a0c' }),
  ]);
  baseBoard.position.set(0, 0.45, -3.1);
  group.add(baseBoard);
  for (const s of [-1, 1]) {
    const led = makeLed(16, 0.8, home, away);
    led.tex.repeat.x = 1;
    leds.push(led);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(16, 0.8), ledMat(led.tex));
    b.position.set(s * 9.3, 0.4, 6.5);
    b.rotation.y = -s * Math.PI / 2;
    group.add(b);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 16), new THREE.MeshStandardMaterial({ color: '#0a0a0c' }));
    back.position.set(s * 9.36, 0.4, 6.5);
    group.add(back);
  }

  // ---------- crowd ----------
  const fascia = makeLed(16, 1, home, away, 2048);
  leds.push(fascia);
  const crowd = buildCrowd(group, { quality, ledTex: fascia.tex });

  // ---------- hoop ----------
  const hoop = new THREE.Group();
  group.add(hoop);
  const pad = new THREE.MeshStandardMaterial({ color: '#16181d', roughness: 0.75 });
  const steel = new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.45, metalness: 0.6 });
  const baseUnit = new THREE.Mesh(new RoundedBoxGeometry(1.5, 1.05, 2.2, 3, 0.12), pad);
  baseUnit.position.set(0, 0.52, -3.5);
  const padFront = new THREE.Mesh(new RoundedBoxGeometry(1.52, 0.9, 0.35, 3, 0.1), new THREE.MeshStandardMaterial({ color: home.secondary, roughness: 0.75 }));
  padFront.position.set(0, 0.5, -2.35);
  const post = new THREE.Mesh(new RoundedBoxGeometry(0.34, 3.1, 0.34, 2, 0.06), pad);
  post.position.set(0, 2.5, -3.2);
  const arm = new THREE.Mesh(new RoundedBoxGeometry(0.26, 0.3, 3.9, 2, 0.05), steel);
  arm.position.set(0, 3.72, -1.0);
  arm.rotation.x = 0.1;
  const armLow = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 3.6, 10), steel);
  armLow.position.set(0, 3.25, -1.2);
  armLow.rotation.x = Math.PI / 2 - 0.28;
  for (const m of [baseUnit, padFront, post, arm, armLow]) { m.castShadow = true; m.receiveShadow = true; hoop.add(m); }

  // backboard glass + frame
  const bw = COURT.boardW, bh = COURT.boardH, byc = COURT.boardBottom + bh / 2, bz = COURT.boardZ - 0.015;
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(bw, bh, 0.03),
    new THREE.MeshPhysicalMaterial({ color: '#cfe3ea', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.2, envMapIntensity: 0.9, clearcoat: 0.6, depthWrite: false })
  );
  glass.position.set(0, byc, bz);
  glass.renderOrder = 3;
  glass.layers.set(1); // main camera only: keeps the glass out of the floor reflection
  hoop.add(glass);
  const white = new THREE.MeshStandardMaterial({ color: '#f4f6f8', roughness: 0.4, emissive: '#222222' });
  const bar = (w, h, x, y, z = bz + 0.017) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.006), white); m.position.set(x, y, z); m.layers.set(1); hoop.add(m); return m; };
  bar(bw, 0.05, 0, COURT.boardBottom + bh - 0.025); bar(bw, 0.05, 0, COURT.boardBottom + 0.025);
  bar(0.05, bh, -bw / 2 + 0.025, byc); bar(0.05, bh, bw / 2 - 0.025, byc);
  const iw = 0.61, ih = 0.457, iy = COURT.rimY + 0.02;
  bar(iw, 0.05, 0, iy + ih); bar(iw, 0.05, 0, iy + 0.025);
  bar(0.05, ih, -iw / 2 + 0.025, iy + ih / 2); bar(0.05, ih, iw / 2 - 0.025, iy + ih / 2);
  // board LED edge (lights red at the buzzer)
  const edgeMat = new THREE.MeshBasicMaterial({ color: '#2a0a08', toneMapped: false });
  const edgeT = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.04, 0.03, 0.04), edgeMat); edgeT.position.set(0, COURT.boardBottom + bh + 0.015, bz); hoop.add(edgeT);
  const edgeL = new THREE.Mesh(new THREE.BoxGeometry(0.03, bh, 0.04), edgeMat); edgeL.position.set(-bw / 2 - 0.02, byc, bz); hoop.add(edgeL);
  const edgeR = edgeL.clone(); edgeR.position.x *= -1; hoop.add(edgeR);
  // board frame support behind glass
  const frameBack = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.06), steel);
  frameBack.position.set(0, byc, bz - 0.06);
  hoop.add(frameBack);

  // shot clock unit on top
  const clock = makeClockFace();
  const clockBox = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.32, 0.18), [
    steel, steel, steel, steel, new THREE.MeshBasicMaterial({ map: clock.tex, toneMapped: false }), steel,
  ]);
  clockBox.position.set(0, COURT.boardBottom + bh + 0.22, bz - 0.02);
  hoop.add(clockBox);

  // rim + bracket
  const rimMat = new THREE.MeshStandardMaterial({ color: '#e0521b', roughness: 0.32, metalness: 0.55, envMapIntensity: 0.8 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(COURT.rimR + COURT.rimTube, COURT.rimTube, 10, 56), rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.copy(RIM);
  rim.castShadow = true;
  hoop.add(rim);
  const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, COURT.rimZ - COURT.rimR - COURT.boardZ + 0.02), rimMat);
  bracket.position.set(0, COURT.rimY - 0.02, (COURT.boardZ + COURT.rimZ - COURT.rimR) / 2);
  hoop.add(bracket);
  const brPlate = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.02), rimMat);
  brPlate.position.set(0, COURT.rimY - 0.05, COURT.boardZ + 0.01);
  hoop.add(brPlate);
  // hooks for the net
  const hookMat = new THREE.MeshStandardMaterial({ color: '#b84414', metalness: 0.5, roughness: 0.4 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.03, 0.012), hookMat);
    h.position.set(RIM.x + Math.cos(a) * COURT.rimR, RIM.y - 0.015, RIM.z + Math.sin(a) * COURT.rimR);
    hoop.add(h);
  }

  // ---------- runtime ----------
  let t = 0;
  const api = {
    group, reflector, hoop, rim, crowd,
    setShotClock: (v, red = true) => clock.draw(v, red),
    buzzer(on) { edgeMat.color.set(on ? '#ff2a1a' : '#2a0a08'); },
    // home = the play went the home crowd's way
    cheer(amount = 1, home = true) { crowd.cheer(amount, home); },
    rise(home = true) { crowd.rise(home); },
    settle() { crowd.settle(); },
    update(dt, camera) {
      t += dt;
      for (const l of leds) l.tex.offset.x = (t * 0.03) % 1;
      crowd.update(dt, camera);
    },
  };
  return api;
}
