// The brand logo on the title and loading screens: the Gamify logo (seven-dot mark in its own colours,
// white wordmark). playMark pops the dots in, on the loading screen and when you tap or point at the logo.
// The API (playMark(el, kind)) is the one the game already calls.
const css = `
@keyframes gm-pop { 0% { transform: scale(.6); opacity: 0 } 60% { transform: scale(1.06); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
.lw.lw-build > img, .lw.lw-scramble > img { animation: gm-pop 420ms cubic-bezier(.2,.8,.2,1) both }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

const still = matchMedia('(prefers-reduced-motion: reduce)');

// play the pop on a .lw logo (or on the first one inside el)
export function playMark(el, kind = 'scramble') {
  const lw = el && (el.classList.contains('lw') ? el : el.querySelector('.lw'));
  if (!lw || still.matches) return;
  lw.classList.remove('lw-build', 'lw-scramble');
  void lw.offsetWidth;   // restart the keyframes if it was already playing
  lw.classList.add(`lw-${kind}`);
}

for (const lw of document.querySelectorAll('.lw')) {
  lw.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') playMark(lw); });
  lw.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') playMark(lw); });
}
const ld = document.getElementById('loading');
if (ld && !ld.hidden) playMark(ld, 'build');
