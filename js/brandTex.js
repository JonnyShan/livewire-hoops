// Brand colours on the photographed textures (players and crowd). The Gamify core uses the files as they are.
// A pack with its own textures folder (Livewire) uses those files; any other pack gets the plain kits in
// models/neutral/ (no lettering) with the Gamify blue repainted in its accent, keeping the fabric's shading.
import * as THREE from 'three';
import { BRAND } from './data.js';

const CORE_BLUE_V = 0.816;   // brightness of the core blue (#1F82D0) the textures are made in

function load(url) {
  return new Promise((res) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
}

// repaint the core blue in the brand accent
export function repaintBlue(img) {
  const c = document.createElement('canvas'); c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
  const A = [1, 3, 5].map((i) => parseInt(BRAND.accent.substr(i, 2), 16));
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i] / 255, gg = p[i + 1] / 255, b = p[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), dl = mx - mn;
    if (dl < 0.1 || mx < 0.12) continue;
    const h = mx === r ? (60 * ((gg - b) / dl) + 360) % 360 : mx === gg ? 60 * ((b - r) / dl) + 120 : 60 * ((r - gg) / dl) + 240;
    if (h < 185 || h > 230) continue;
    const w = Math.min(1, (dl / mx - 0.25) / 0.2) * Math.min(1, (mx - 0.12) / 0.12);
    if (w <= 0) continue;
    const shade = Math.min(1.25, mx / CORE_BLUE_V);
    for (let k = 0; k < 3; k++) p[i + k] = p[i + k] * (1 - w) + Math.min(255, A[k] * shade) * w;
  }
  g.putImageData(d, 0, 0);
  return c;
}

function like(src, image) {
  const t = image instanceof HTMLCanvasElement ? new THREE.CanvasTexture(image) : new THREE.Texture(image);
  if (src) { t.flipY = src.flipY; t.colorSpace = src.colorSpace; t.wrapS = src.wrapS; t.wrapT = src.wrapT; t.channel = src.channel; }
  else t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

const cache = new Map();
// the colour map for a player model (models/<name>.json or .glb) in this brand
export function brandMap(modelUrl, src) {
  if (!BRAND.textures) return Promise.resolve(src);
  const name = modelUrl.split('/').pop().replace(/\.(json|glb)$/, '');
  if (!cache.has(name)) {
    cache.set(name, (async () => {
      if (BRAND.textures === 'neutral') {
        const img = await load(`models/neutral/${name}.webp`);
        return img ? like(src, repaintBlue(img)) : src;
      }
      const img = await load(`${BRAND.textures}${name}.webp`);
      return img ? like(src, img) : src;
    })());
  }
  return cache.get(name);
}

// the crowd atlas: the pack's own, else the core's with its blue in the brand accent
export async function brandFans(coreUrl) {
  if (BRAND.fans) return BRAND.fans;
  if (BRAND.id === 'gamify') return coreUrl;
  const img = await load(coreUrl);
  return img ? repaintBlue(img).toDataURL('image/webp', 0.9) : coreUrl;
}
