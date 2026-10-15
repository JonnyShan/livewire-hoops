// Arena: hardwood floor + full-court markings, glossy reflections, the crowd
// (crowd.js), LED boards, and both hoops (stanchion, glass, rim, shot clock).
// Units are metres. Court frame (court.js): baseline A at z = 0, centre line at
// z = 14.33, baseline B at z = 28.66, x = lateral. Basket B is basket A turned
// half a turn about the centre spot (x -> -x, z -> len - z), and so is
// everything at its end: hoop, key, lines, baseline wordmarks, LED board.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BRAND } from './data.js';
import { buildCrowd } from './crowd.js';

import { COURT, RIM, BASKETS, isThree } from './court.js';
export { COURT, RIM, BASKETS, isThree };

// hardwood: the court plus a 2.5 m apron all round
const WOOD = { halfW: 9, z0: -2.5, z1: COURT.len + 2.5 };

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
// One canvas over the whole floor, 18 m x 36 m (2:1, so the texels stay square),
// centred on the centre spot. Canvas x = court x, canvas y = court z (top = basket A).
const MK = { x0: -9, w: 18, l: 36, z0: COURT.halfLen - 18 };
function drawCourt(ctx, home, logoImg) {
  const k = ctx.canvas.width / MK.w;
  const X = (x) => (x - MK.x0) * k;
  const Z = (z) => (z - MK.z0) * k;
  const L = COURT.len, HL = COURT.halfLen;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // draw basket A's end, then the same again turned half a turn about the centre spot for basket B's
  const bothEnds = (draw) => {
    draw();
    ctx.save();
    ctx.translate(X(0), Z(HL));
    ctx.rotate(Math.PI);
    ctx.translate(-X(0), -Z(HL));
    draw();
    ctx.restore();
  };

  // apron (the wood outside the lines) stained in the home team's dark colour
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = home.secondary;
  ctx.beginPath();
  ctx.rect(X(-WOOD.halfW), Z(WOOD.z0), WOOD.halfW * 2 * k, (WOOD.z1 - WOOD.z0) * k);
  ctx.rect(X(-COURT.halfW), Z(0), COURT.halfW * 2 * k, L * k);
  ctx.fill('evenodd');
  ctx.globalAlpha = 1;

  // painted keys (a branded home team paints them in its dark colour)
  bothEnds(() => {
    ctx.globalAlpha = home.brand ? 0.92 : 0.86;
    ctx.fillStyle = home.brand ? home.secondary : home.primary;
    ctx.fillRect(X(-COURT.keyW / 2), Z(0), COURT.keyW * k, COURT.ftZ * k);
    ctx.globalAlpha = 1;
  });

  // centre circle + logo (reads from the broadcast end, +z)
  ctx.save();
  ctx.beginPath();
  ctx.arc(X(0), Z(HL), COURT.circleR * k, 0, Math.PI * 2);
  ctx.globalAlpha = home.brand ? 0.94 : 0.85;
  ctx.fillStyle = home.brand ? home.secondary : home.primary;
  ctx.fill();
  ctx.globalAlpha = 1;
  if (logoImg) {
    // fit inside the circle, keeping the image's own proportions
    const s = (home.brand ? 2.3 : 3.1) * k, ar = logoImg.width / logoImg.height || 1;
    const w = ar >= 1 ? s : s * ar, h = ar >= 1 ? s / ar : s;
    ctx.drawImage(logoImg, X(0) - w / 2, Z(HL) - h / 2, w, h);
  }
  ctx.restore();

  // apron wordmarks: two on each baseline, one on each sideline per half (all read from the court)
  bothEnds(() => {
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
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(X(side * 8.3), Z(7));
      ctx.rotate(side * Math.PI / 2);
      drawWordmark(ctx, 0, 0, 0.5 * k, 'rgba(203,254,0,0.9)');
      ctx.restore();
    }
  });

  // lines
  ctx.strokeStyle = ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.lineWidth = 0.055 * k;
  ctx.lineCap = 'butt';
  const line = (x1, z1, x2, z2) => { ctx.beginPath(); ctx.moveTo(X(x1), Z(z1)); ctx.lineTo(X(x2), Z(z2)); ctx.stroke(); };
  ctx.strokeRect(X(-COURT.halfW), Z(0), COURT.halfW * 2 * k, L * k);       // sidelines + baselines
  line(-COURT.halfW, HL, COURT.halfW, HL);                                   // centre line
  ctx.beginPath(); ctx.arc(X(0), Z(HL), COURT.circleR * k, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(X(0), Z(HL), 0.61 * k, 0, Math.PI * 2); ctx.stroke();
  bothEnds(() => {
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
    // three-point line: corner lines + arc
    const a = Math.atan2(COURT.cornerZ - COURT.rimZ, COURT.cornerX);
    line(-COURT.cornerX, 0, -COURT.cornerX, COURT.cornerZ);
    line(COURT.cornerX, 0, COURT.cornerX, COURT.cornerZ);
    ctx.beginPath(); ctx.arc(X(0), Z(COURT.rimZ), COURT.threeR * k, a, Math.PI - a); ctx.stroke();
    // lane hash marks
    for (const z of [2.13, 2.44, 3.35, 4.27]) {
      const w = z === 2.44 ? 0.3 : 0.05;
      for (const s of [-1, 1]) ctx.fillRect(X(s * COURT.keyW / 2) + (s > 0 ? 0 : -0.15 * k), Z(z), 0.15 * k, w * k);
    }
  });
}

// ---------- LED ribbon board ----------
// a 16 m loop of messages (w x h metres); longer boards repeat it
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
    ['3 ON 3 · FULL COURT', '#ffffff'],
    away.brand ? ['HOOPS', '#ffffff'] : [teamName(away).toUpperCase(), away.primary],
    [BRAND, BRAND.yellow],
  ];
  const draw = (hot = 0) => {
    g.fillStyle = '#05060a';
    g.fillRect(0, 0, c.width, c.height);
    const seg = c.width / msgs.length;
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
        // shrink anything that would run into the next message
        let px = Math.round(c.height * 0.62);
        g.font = `800 ${px}px "Saira Extra Condensed", "Arial Narrow", sans-serif`;
        const tw = g.measureText(txt).width;
        if (tw > seg * 0.88) {
          px = Math.floor(px * seg * 0.88 / tw);
          g.font = `800 ${px}px "Saira Extra Condensed", "Arial Narrow", sans-serif`;
        }
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

// ---------- hoop ----------
// built at basket A (baseline z = 0, glass facing +z); basket B is the same group turned half a turn
function buildHoop(M) {
  const hoop = new THREE.Group();
  const baseUnit = new THREE.Mesh(M.baseGeo, M.pad);
  baseUnit.position.set(0, 0.52, -3.5);
  const padFront = new THREE.Mesh(M.padFrontGeo, M.padFront);
  padFront.position.set(0, 0.5, -2.35);
  const post = new THREE.Mesh(M.postGeo, M.pad);
  post.position.set(0, 2.5, -3.2);
  const arm = new THREE.Mesh(M.armGeo, M.steel);
  arm.position.set(0, 3.72, -1.0);
  arm.rotation.x = 0.13;
  const armLow = new THREE.Mesh(M.armLowGeo, M.steel);
  armLow.position.set(0, 3.25, -1.2);
  armLow.rotation.x = Math.PI / 2 - 0.28;
  for (const m of [baseUnit, padFront, post, arm, armLow]) { m.castShadow = true; m.receiveShadow = true; hoop.add(m); }

  // backboard glass + frame
  const bw = COURT.boardW, bh = COURT.boardH, byc = COURT.boardBottom + bh / 2, bz = COURT.boardZ - 0.015;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.03), M.glass);
  glass.position.set(0, byc, bz);
  glass.renderOrder = 3;
  glass.layers.set(1); // main camera only: keeps the glass out of the floor reflection
  hoop.add(glass);
  const bar = (w, h, x, y, z = bz + 0.017) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.006), M.white); m.position.set(x, y, z); m.layers.set(1); hoop.add(m); return m; };
  bar(bw, 0.05, 0, COURT.boardBottom + bh - 0.025); bar(bw, 0.05, 0, COURT.boardBottom + 0.025);
  bar(0.05, bh, -bw / 2 + 0.025, byc); bar(0.05, bh, bw / 2 - 0.025, byc);
  const iw = 0.61, ih = 0.457, iy = COURT.rimY + 0.02;
  bar(iw, 0.05, 0, iy + ih); bar(iw, 0.05, 0, iy + 0.025);
  bar(0.05, ih, -iw / 2 + 0.025, iy + ih / 2); bar(0.05, ih, iw / 2 - 0.025, iy + ih / 2);
  // board LED edge (lights red at the buzzer)
  const edgeT = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.04, 0.03, 0.04), M.edge); edgeT.position.set(0, COURT.boardBottom + bh + 0.015, bz); hoop.add(edgeT);
  const edgeL = new THREE.Mesh(new THREE.BoxGeometry(0.03, bh, 0.04), M.edge); edgeL.position.set(-bw / 2 - 0.02, byc, bz); hoop.add(edgeL);
  const edgeR = edgeL.clone(); edgeR.position.x *= -1; hoop.add(edgeR);
  // where the arm meets the glass: kept low and narrow so a camera high behind
  // the basket (play at basket B) still sees the rim through the glass
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.3, 0.25), M.steel);
  mount.position.set(0, 3.42, bz - 0.155);
  hoop.add(mount);

  // shot clock unit on top: the time shows front and back
  const clockBox = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.32, 0.18), [M.steel, M.steel, M.steel, M.steel, M.clock, M.clock]);
  clockBox.position.set(0, COURT.boardBottom + bh + 0.22, bz - 0.02);
  hoop.add(clockBox);

  // rim + bracket
  const rim = new THREE.Mesh(new THREE.TorusGeometry(COURT.rimR + COURT.rimTube, COURT.rimTube, 10, 56), M.rim);
  rim.rotation.x = Math.PI / 2;
  rim.position.copy(RIM);
  rim.castShadow = true;
  hoop.add(rim);
  const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, COURT.rimZ - COURT.rimR - COURT.boardZ + 0.02), M.rim);
  bracket.position.set(0, COURT.rimY - 0.02, (COURT.boardZ + COURT.rimZ - COURT.rimR) / 2);
  hoop.add(bracket);
  const brPlate = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.02), M.rim);
  brPlate.position.set(0, COURT.rimY - 0.05, COURT.boardZ + 0.01);
  hoop.add(brPlate);
  // hooks for the net
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const h = new THREE.Mesh(M.hookGeo, M.hook);
    h.position.set(RIM.x + Math.cos(a) * COURT.rimR, RIM.y - 0.015, RIM.z + Math.sin(a) * COURT.rimR);
    hoop.add(h);
  }
  return { group: hoop, rim };
}

export async function buildArena(scene, renderer, { home, away, quality }) {
  const group = new THREE.Group();
  scene.add(group);
  scene.background = new THREE.Color('#040507');
  // the camera can be ~30 m from basket A (play at basket B): keep that end clear of the fog
  scene.fog = new THREE.Fog('#0a0b0e', 40, 100);

  // lights
  const hemi = new THREE.HemisphereLight('#ffe9d0', '#140e0a', 0.32);
  group.add(hemi);
  // key light: a fixed direction; follow() slides it (and its shadow frustum) along with the play
  const KEY_OFF = new THREE.Vector3(3.5, 17, 5);
  const SHADOW_SPAN = 22;
  const key = new THREE.DirectionalLight('#fff0dc', 2.25);
  key.castShadow = quality !== 'low';
  const sm = quality === 'high' ? 2048 : 1024;
  key.shadow.mapSize.set(sm, sm);
  const sh = SHADOW_SPAN / 2;
  Object.assign(key.shadow.camera, { left: -sh, right: sh, top: sh, bottom: -sh, near: 4, far: 40 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  group.add(key, key.target);
  // the shadow camera's axes (it looks from KEY_OFF toward the target, up = +y)
  const kz = KEY_OFF.clone().normalize();
  const kx = new THREE.Vector3(0, 1, 0).cross(kz).normalize();
  const ky = new THREE.Vector3().crossVectors(kz, kx);
  const texel = SHADOW_SPAN / sm;
  const _c = new THREE.Vector3();
  // one warm pool of light rides with the play (a spot light at each end would light every pixel twice)
  const spot = new THREE.SpotLight('#ffe7c4', 30, 30, 0.46, 0.75, 1.6);
  group.add(spot, spot.target);
  const follow = (x, z) => {
    // (z is where the camera looks, a few metres up the floor from the play)
    const sz = THREE.MathUtils.clamp(z + 2.8, 4, COURT.len - 4);
    spot.position.set(0, 13, sz);
    spot.target.position.set(0, 0, sz);
    // snap the frustum to whole shadow-map texels so the shadows don't crawl as it moves
    _c.set(x, 0, z);
    const a = _c.dot(kx), b = _c.dot(ky);
    _c.addScaledVector(kx, Math.round(a / texel) * texel - a).addScaledVector(ky, Math.round(b / texel) * texel - b);
    key.target.position.copy(_c);
    key.position.copy(_c).add(KEY_OFF);
  };
  follow(0, 7);
  const fill = new THREE.DirectionalLight('#dfe8ff', 0.18);
  fill.position.set(-6, 10, -4);
  group.add(fill);

  // dark arena floor beyond the court
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(110, 110),
    new THREE.MeshStandardMaterial({ color: '#0c0c0f', roughness: 0.9 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.01, COURT.halfLen);
  ground.receiveShadow = true;
  group.add(ground);

  // hardwood
  const woodTex = tex('img/floor.webp');
  woodTex.wrapS = woodTex.wrapT = THREE.MirroredRepeatWrapping;
  const woodW = WOOD.halfW * 2, woodL = WOOD.z1 - WOOD.z0;
  woodTex.repeat.set(woodW / 1.7, woodL / 1.7);
  woodTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const wood = new THREE.Mesh(
    new THREE.PlaneGeometry(woodW, woodL),
    new THREE.MeshStandardMaterial({ map: woodTex, color: '#d6b690', roughness: 0.32, metalness: 0.0, envMapIntensity: 0.25 })
  );
  wood.rotation.x = -Math.PI / 2;
  wood.position.set(0, 0, (WOOD.z0 + WOOD.z1) / 2);
  wood.receiveShadow = true;
  group.add(wood);

  // markings: 2048 x 4096 (114 px a metre); low quality, or a GPU without 4k textures, gets half
  const mkCanvas = document.createElement('canvas');
  const mkW = quality === 'low' || renderer.capabilities.maxTextureSize < 4096 ? 1024 : 2048;
  mkCanvas.width = mkW;
  mkCanvas.height = mkW * MK.l / MK.w;
  const logoImg = await loadImage(home.brand ? 'img/livewire-mark.png' : home.logo);
  try {
    await Promise.all(['700', '800', '900'].map((w) => document.fonts.load(`${w} 40px "Saira Extra Condensed"`)));
  } catch (e) { /* fallback font */ }
  drawCourt(mkCanvas.getContext('2d'), home, logoImg);
  const mkTex = new THREE.CanvasTexture(mkCanvas);
  mkTex.colorSpace = THREE.SRGBColorSpace;
  mkTex.anisotropy = woodTex.anisotropy;
  const markings = new THREE.Mesh(
    new THREE.PlaneGeometry(MK.w, MK.l),
    new THREE.MeshStandardMaterial({ map: mkTex, transparent: true, roughness: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, envMapIntensity: 0.25 })
  );
  markings.rotation.x = -Math.PI / 2;
  markings.position.set(0, 0.001, MK.z0 + MK.l / 2);
  markings.receiveShadow = true;
  group.add(markings);

  // glossy floor reflection over the whole floor. Its cost is set by the render
  // target (sized from the screen), not by how much floor the plane covers.
  let reflector = null;
  if (quality !== 'low') {
    const scale = quality === 'high' ? 0.6 : 0.4;
    const w = Math.round(window.innerWidth * Math.min(2, window.devicePixelRatio) * scale);
    const h = Math.round(window.innerHeight * Math.min(2, window.devicePixelRatio) * scale);
    reflector = new Reflector(new THREE.PlaneGeometry(20, WOOD.z1 - WOOD.z0 + 4), {
      textureWidth: w, textureHeight: h, clipBias: 0.003, shader: ReflectShader, multisample: 0,
    });
    reflector.material.transparent = true;
    reflector.material.blending = THREE.AdditiveBlending;
    reflector.material.depthWrite = false;
    reflector.material.uniforms.texel.value.set(1 / w, 1 / h);
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.set(0, 0.002, COURT.halfLen);
    reflector.renderOrder = 2;
    group.add(reflector);
  }

  // LED boards: one behind each baseline (low enough to clear the camera at the
  // +z end) and one down each full sideline
  const leds = [];
  const ledMat = (t) => new THREE.MeshBasicMaterial({ map: t, toneMapped: false, color: '#d8d8d8' });
  const dark = new THREE.MeshStandardMaterial({ color: '#0a0a0c' });
  const base = makeLed(14, 0.9, home, away);
  leds.push(base);
  const baseGeo = new THREE.BoxGeometry(15, 0.9, 0.12);
  const baseMats = [dark, dark, dark, dark, ledMat(base.tex), dark];
  for (const b of BASKETS) {
    const board = new THREE.Mesh(baseGeo, baseMats);
    board.position.set(0, 0.45, b.baseZ - b.dir * 3.1);
    board.rotation.y = b.i ? Math.PI : 0;
    group.add(board);
  }
  const sideLen = COURT.len + 3.2;
  const side = makeLed(16, 0.8, home, away);
  side.tex.repeat.x = sideLen / 16;
  leds.push(side);
  const sideMat = ledMat(side.tex);
  const sideGeo = new THREE.PlaneGeometry(sideLen, 0.8);
  const sideBackGeo = new THREE.BoxGeometry(0.1, 0.8, sideLen);
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(sideGeo, sideMat);
    b.position.set(s * 9.3, 0.4, COURT.halfLen);
    b.rotation.y = -s * Math.PI / 2;
    group.add(b);
    const back = new THREE.Mesh(sideBackGeo, dark);
    back.position.set(s * 9.36, 0.4, COURT.halfLen);
    group.add(back);
  }

  // ---------- crowd ----------
  const fascia = makeLed(16, 1, home, away, 2048);
  leds.push(fascia);
  const crowd = buildCrowd(group, { quality, ledTex: fascia.tex });

  // ---------- hoops ----------
  const clock = makeClockFace();
  const edgeMat = new THREE.MeshBasicMaterial({ color: '#2a0a08', toneMapped: false });
  const steel = new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.45, metalness: 0.6 });
  const M = {
    pad: new THREE.MeshStandardMaterial({ color: '#16181d', roughness: 0.75 }),
    padFront: new THREE.MeshStandardMaterial({ color: home.secondary, roughness: 0.75 }),
    steel,
    glass: new THREE.MeshPhysicalMaterial({ color: '#cfe3ea', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.2, envMapIntensity: 0.9, clearcoat: 0.6, depthWrite: false }),
    white: new THREE.MeshStandardMaterial({ color: '#f4f6f8', roughness: 0.4, emissive: '#222222' }),
    edge: edgeMat,
    clock: new THREE.MeshBasicMaterial({ map: clock.tex, toneMapped: false }),
    rim: new THREE.MeshStandardMaterial({ color: '#e0521b', roughness: 0.32, metalness: 0.55, envMapIntensity: 0.8 }),
    hook: new THREE.MeshStandardMaterial({ color: '#b84414', metalness: 0.5, roughness: 0.4 }),
    baseGeo: new RoundedBoxGeometry(1.5, 1.05, 2.2, 3, 0.12),
    padFrontGeo: new RoundedBoxGeometry(1.52, 0.9, 0.35, 3, 0.1),
    postGeo: new RoundedBoxGeometry(0.34, 3.1, 0.34, 2, 0.06),
    armGeo: new RoundedBoxGeometry(0.26, 0.3, 3.9, 2, 0.05),
    armLowGeo: new THREE.CylinderGeometry(0.035, 0.035, 3.6, 10),
    hookGeo: new THREE.BoxGeometry(0.012, 0.03, 0.012),
  };
  const hoops = BASKETS.map((b) => {
    const h = buildHoop(M);
    if (b.i === 1) {
      // half a turn about the centre spot: (x, z) -> (-x, len - z)
      h.group.rotation.y = Math.PI;
      h.group.position.set(0, 0, COURT.len);
    }
    group.add(h.group);
    h.group.updateMatrixWorld(true);
    return h;
  });

  // ---------- runtime ----------
  let t = 0;
  const api = {
    group, reflector, crowd,
    hoops: hoops.map((h) => h.group),
    rims: hoops.map((h) => h.rim),
    // basket A, for callers that only know one hoop
    hoop: hoops[0].group,
    rim: hoops[0].rim,
    // keep the key light's shadow frustum (22 m square) centred on the play
    follow,
    // both shot clocks show the same time
    setShotClock: (v, red = true) => clock.draw(v, red),
    // both boards' LED edges
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
