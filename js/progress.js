// Download progress for the Start button. The two player models are most of
// the download, so they report bytes as they stream in; everything else
// (textures, the arena photo, the motion library) is counted per file through
// three's default loading manager.
import * as THREE from 'three';

const models = new Map();          // url -> { loaded, total }
let files = { done: 0, total: 0 };
let shown = 0;
let listener = null;

THREE.DefaultLoadingManager.onProgress = (url, done, total) => { files = { done, total }; emit(); };

export function modelProgress(url, loaded, total) {
  models.set(url, { loaded, total: Math.max(total, loaded, 1) });
  emit();
}

// 0..1, never goes backwards (new files can join the queue mid-load)
export function fraction() {
  let l = 0, t = 0;
  for (const m of models.values()) { l += m.loaded; t += m.total; }
  const mf = models.size ? l / t : 0;
  const ff = files.total ? files.done / files.total : 0;
  shown = Math.max(shown, Math.min(0.99, 0.75 * mf + 0.25 * ff));
  return shown;
}

export function onProgress(fn) { listener = fn; emit(); }
function emit() { if (listener) listener(fraction()); }
