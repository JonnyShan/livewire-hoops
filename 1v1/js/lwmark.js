// The Livewire mark at the top right of the wordmark's E: a 4×4 grid of squares
// that flickers through a short sequence and settles into the mark. The frames
// are Livewire's own, from the logo on livewire.group: a sweep-and-build when the
// logo first appears, and a scramble when you point at it (here also on tap).
// Each frame lists the four rows, top to bottom; 1 is a lit square.
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

// Each sequence runs as CSS keyframes on the squares' opacity rather than on
// timers, so the browser keeps it going while the 3D setup has the main thread.
let css = '';
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
  const m = lw.querySelector('.lwm');
  m.innerHTML = [...MARK.replace(/ /g, '')].map((b) => `<i${b === '1' ? ' class="on"' : ''}></i>`).join('');
  // point at it (mouse) or tap it to run the scramble again
  lw.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') playMark(lw); });
  lw.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') playMark(lw); });
}
// the loading screen is up from the first paint: build its mark in straight away
const ld = document.getElementById('loading');
if (ld && !ld.hidden) playMark(ld, 'build');
