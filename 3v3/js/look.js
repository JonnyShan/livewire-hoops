// The broadcast look: arena lighting from a 360° photo of a packed arena, and
// a colour grade applied inside the tone mapper (so it costs nothing extra on
// phones, where there is no post-processing pass).
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// phones get the half-size photo: it's blurred for lighting either way
export const envUrl = (quality) => (quality === 'high' ? 'img/arena-360.webp' : 'img/arena-360-2k.webp');

// ACES filmic, then a TV-sports grade: firmer contrast, a little more colour,
// cool shadows and warm highlights, and blacks that stay black.
const GRADE = /* glsl */`
vec3 hwGrade( vec3 c ) {
  c = pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, 1.12 );
  c = mix( c, c * c * ( 3.0 - 2.0 * c ), 0.22 );
  c = max( c - 0.012, 0.0 ) / 0.988;
  l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c *= mix( vec3( 0.965, 0.99, 1.04 ), vec3( 1.0 ), smoothstep( 0.0, 0.45, l ) );
  c *= mix( vec3( 1.0 ), vec3( 1.035, 1.01, 0.96 ), smoothstep( 0.5, 1.0, l ) );
  return pow( clamp( c, 0.0, 1.0 ), vec3( 2.2 ) );
}
vec3 CustomToneMapping( vec3 color ) { return hwGrade( ACESFilmicToneMapping( color ) ); }`;

let installed = false;
// swap three's empty CustomToneMapping for the graded ACES curve (before any shader compiles)
export function installGrade() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment
    .replace('vec3 CustomToneMapping( vec3 color ) { return color; }', GRADE);
}

// final pass for the post-processed (high quality) path: grade + sRGB output
export function makeGradePass(renderer) {
  // raw shader (like three's OutputPass) so the chunks aren't included twice
  const mat = new THREE.RawShaderMaterial({
    name: 'GradeOutput',
    uniforms: { tDiffuse: { value: null }, toneMappingExposure: { value: 1 } },
    vertexShader: /* glsl */`
      precision highp float;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      attribute vec3 position;
      attribute vec2 uv;
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D tDiffuse;
      #include <tonemapping_pars_fragment>
      #include <colorspace_pars_fragment>
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D( tDiffuse, vUv );
        gl_FragColor = vec4( sRGBTransferOETF( vec4( CustomToneMapping( t.rgb ), 1.0 ) ).rgb, t.a );
      }`,
  });
  const pass = new ShaderPass(mat);
  const render = pass.render.bind(pass);
  pass.render = (r, w, rd, dt, m) => { mat.uniforms.toneMappingExposure.value = renderer.toneMappingExposure; render(r, w, rd, dt, m); };
  return pass;
}

// The panorama is an ordinary photo (8-bit), so the ceiling lights are clipped
// at white. Expanding the brightest pixels back out gives them the punch of real
// floodlights, which is what makes the overhead light and the reflections read.
function toHDR(img, w) {
  const h = w / 2;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const out = new Uint16Array(w * h * 4);
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const v = i / 255; lin[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    const r = lin[px[k]], gg = lin[px[k + 1]], b = lin[px[k + 2]];
    const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    const hot = Math.max(0, Math.min(1, (l - 0.62) / 0.36));
    const up = 1 + 22 * hot * hot * hot;
    out[k] = toHalf(r * up); out[k + 1] = toHalf(gg * up); out[k + 2] = toHalf(b * up); out[k + 3] = 15360; // 1.0
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const imgs = new Map();
function loadImg(url) {
  if (!imgs.has(url)) {
    const p = new Promise((res, rej) => {
      const im = new Image();
      THREE.DefaultLoadingManager.itemStart(url);
      im.onload = () => { THREE.DefaultLoadingManager.itemEnd(url); res(im); };
      im.onerror = () => { THREE.DefaultLoadingManager.itemError(url); THREE.DefaultLoadingManager.itemEnd(url); rej(new Error('failed to load ' + url)); };
      im.src = url;
    });
    p.catch(() => imgs.delete(url));
    imgs.set(url, p);
  }
  return imgs.get(url);
}

// { env: prefiltered environment for lighting and reflections, background: the photo itself }
export async function loadArenaLight(renderer, quality) {
  const img = await loadImg(envUrl(quality));
  const hdr = toHDR(img, quality === 'low' ? 512 : quality === 'med' ? 1024 : 2048);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(hdr).texture;
  pmrem.dispose();
  hdr.dispose();
  const background = new THREE.Texture(img);
  background.mapping = THREE.EquirectangularReflectionMapping;
  background.colorSpace = THREE.SRGBColorSpace;
  background.needsUpdate = true;
  return { env, background };
}
