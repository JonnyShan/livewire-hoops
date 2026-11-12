// The brand logo on the title and loading screens, and the brand words in the page (js/brand-boot.js).
// logoStyle 'image' (Gamify and most packs): the logo file, popped in. logoStyle 'grid' (Livewire): the wordmark
// path with a 4x4 grid of squares at the top right of the E that flickers through a short sequence and settles
// into the mark (Livewire's own frames, from livewire.group: a sweep-and-build when the logo first appears, and
// a scramble when you point at it or tap it). playMark(el, kind) is the API the game calls.
const B = window.HOOPS_BRAND;
// Each grid frame lists the four rows, top to bottom; 1 is a lit square.
const BUILD = [   // 40 ms a frame
  '0000 0000 0000 0000', '1000 0000 0000 0000', '1100 1000 0000 0000', '1110 1100 1000 0000',
  '1111 1110 1100 1000', '0111 1111 1110 1100', '0011 0111 1111 1110', '0001 0011 0111 1111',
  '0000 0001 0011 0111', '0000 0000 0001 0011', '0100 1000 0000 0001', '0110 1000 1000 0000',
  '0110 1010 1000 1000', '0110 1011 1000 1100', '0110 1011 1001 1110',
];
const SCRAMBLE = [   // 30 ms a frame
  '0000 0000 1000 1100', '0000 0000 1000 1100', '0000 0000 1010 1100', '0000 0000 1010 1100',
  '0000 0000 1010 1100', '1001 0011 0110 1000', '1001 0011 0110 1000', '1001 0011 0110 1000',
  '1011 1011 0110 1001', '1011 1011 0010 1001', '1011 1011 0010 1001', '0001 1010 0010 1001',
  '0001 1010 0000 1011', '0001 1010 0000 1011', '0000 1010 0000 1111', '1000 1000 0000 1111',
  '1000 1000 0000 1111', '1000 0000 1000 1111', '1000 0000 1000 1111', '1010 0000 1001 0111',
  '1010 0000 1001 0110', '1010 0000 1001 0110', '1110 0001 1001 0110', '1110 0001 1001 0110',
  '1110 0011 1001 0110', '0110 0011 1001 0110', '0110 0011 1001 0110', '0110 1011 1001 1110',
];
const MARK = BUILD[BUILD.length - 1];
const SEQ = { build: [BUILD, 40], scramble: [SCRAMBLE, 30] };

let css = `
@keyframes gm-pop { 0% { transform: scale(.6); opacity: 0 } 60% { transform: scale(1.06); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
.lw.lw-build > img, .lw.lw-scramble > img { animation: gm-pop 420ms cubic-bezier(.2,.8,.2,1) both }
`;
// Each grid sequence runs as CSS keyframes on the squares' opacity rather than on timers, so the browser keeps
// it going while the 3D setup has the main thread.
for (const [kind, [frames, ms]] of Object.entries(SEQ)) {
  const bits = frames.map((f) => f.replace(/ /g, ''));
  for (let k = 0; k < 16; k++) {
    const stops = bits.map((b, i) => `${(i / bits.length * 100).toFixed(2)}%{opacity:${b[k]}}`).join('');
    css += `@keyframes lw-${kind}-${k}{${stops}100%{opacity:${bits.at(-1)[k]}}}` +
      `.lw.lw-${kind} .lwm i:nth-child(${k + 1}){animation:lw-${kind}-${k} ${frames.length * ms}ms steps(1,end) both}`;
  }
}
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

const still = matchMedia('(prefers-reduced-motion: reduce)');

// play a sequence on a .lw logo (or on the first one inside el); it always ends on the mark
export function playMark(el, kind = 'scramble') {
  const lw = el && (el.classList.contains('lw') ? el : el.querySelector('.lw'));
  if (!lw || still.matches) return;
  lw.classList.remove('lw-build', 'lw-scramble');
  void lw.offsetWidth;   // restart the keyframes if it was already playing
  lw.classList.add(`lw-${kind}`);
}

for (const lw of document.querySelectorAll('.lw')) {
  lw.setAttribute('aria-label', B.name);
  if (B.logoStyle === 'grid' && B.wordmark) {
    const W = B.wordmark;
    lw.innerHTML = `<svg viewBox="0 0 ${W.w} ${W.h}" aria-hidden="true"><path fill="currentColor" d="${W.d}"/></svg><span class="lwm"></span>`;
    lw.querySelector('.lwm').innerHTML = [...MARK.replace(/ /g, '')].map((b) => `<i${b === '1' ? ' class="on"' : ''}></i>`).join('');
  } else {
    const img = document.createElement('img'); img.src = B.logo; img.alt = ''; lw.replaceChildren(img);
  }
  // point at it (mouse) or tap it to play it again
  lw.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') playMark(lw); });
  lw.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') playMark(lw); });
}
for (const el of document.querySelectorAll('.bname')) el.textContent = B.name;
for (const el of document.querySelectorAll('.kitword')) el.textContent = B.kitWords[0] || '';
// a brand with a filmed ball plays it on the loading screen (the still, turning, otherwise)
const ld = document.getElementById('loading');
const v = document.getElementById('ldBall');
if (B.ballVideo && v && ld) {
  ld.classList.add('video');
  v.poster = B.ball; v.loop = true; v.autoplay = true; v.preload = 'auto';
  v.innerHTML = B.ballVideo.map((u) => `<source src="${u}" type="video/${u.split('.').pop()}">`).join('');
  v.load(); v.play().catch(() => {});
}
// the loading screen is up from the first paint: build its mark in straight away
if (ld && !ld.hidden) playMark(ld, 'build');
