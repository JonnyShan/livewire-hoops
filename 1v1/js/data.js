// League data: 8 fictional teams, one star player each.
// Ratings are 0-100. Heights in metres.

// Livewire (livewire.group) branding: your team, the arena boards, the UI accent.
export const BRAND = {
  name: 'Livewire',
  yellow: '#CBFE00',
  black: '#1A1A1A',
  // the LIVEWIRE wordmark from livewire.group, as an SVG path in a 108 x 21 box
  wordmark: { w: 108, h: 21, d: 'M43.062 4.74h5.64L49.634 0h-10.74l-4.081 21h10.74l.9-4.74h-5.64l.66-3.42h5.34l.93-4.68h-5.34l.66-3.42ZM32.059 0l-4.35 14.4-.63 2.94h-.75l.57-2.94L28.1 0h-5.37l-1.32 21h9.27l6.84-21h-5.46ZM12.182 21h5.07L21.33 0h-5.07l-4.078 21ZM9.149 0h-5.07L-.002 21h10.47l.931-4.74H5.997L9.15 0ZM106.226 4.74l.929-4.74h-10.74l-4.08 21h10.74l.9-4.74h-5.64l.66-3.42h5.341l.93-4.68h-5.34l.66-3.42h5.64ZM90.066 10.71c1.18-.52 2.03-1.22 2.55-2.1a5.11 5.11 0 0 0 .6-1.41c.12-.511.18-1.035.179-1.56a6.404 6.404 0 0 0-.18-1.56 5.577 5.577 0 0 0-.572-1.44A4.963 4.963 0 0 0 90.604.72C89.724.24 88.655 0 87.396 0h-6.122l-4.079 20.996h5.072l1.672-8.518h.462l1.344 8.518h5.25l-1.38-8.635-1.35-.45v-.68a8.738 8.738 0 0 0 1.801-.521Zm-3.6-6.06c.32-.008.638.054.932.181.258.118.47.32.599.573.076.13.127.271.15.42.041.146.061.298.06.45a2.32 2.32 0 0 1-.09.66c-.048.203-.13.397-.24.573-.208.348-.51.629-.87.811a2.741 2.741 0 0 1-1.35.3h-.955l.78-3.96.984-.008ZM74.263 0l-4.08 21h5.07l4.081-21h-5.071ZM67.617 0l-3.06 12.361-1.11 5.009h-.75l.96-5.009L65.246 0h-6.66l-3.21 12.361-.991 5.009h-.75l.84-5.009L56.215 0h-5.039l-2.55 21h8.19l2.999-12.18 1.021-5.159h.75l-1.02 5.16L58.916 21h8.16l5.61-21h-5.07Z' },
};

export const TEAMS = [
  {
    id: 'livewire', city: '', name: 'Livewire', abbr: 'MORROW', brand: true,
    primary: '#CBFE00', secondary: '#1A1A1A', jersey: '#CBFE00', letters: '#1A1A1A',
    logo: 'img/logo-livewire.png', portrait: 'img/p0.jpg', model: 'models/morrow.json', modelLo: 'models/morrow-lo.json',
    player: {
      first: 'Kade', last: 'Morrow', num: 7, pos: 'PG', height: 1.91,
      skin: '#5b3a29', hair: { style: 'fade', color: '#120d0b' }, beard: '#120d0b',
      r: { three: 84, mid: 82, finish: 80, dunk: 62, handle: 90, speed: 88, defense: 75, block: 32, steal: 80 },
    },
  },
  {
    // Livewire's black kit (the CPU)
    id: 'livewire-black', city: '', name: 'Livewire', abbr: 'VARGA', brand: true,
    primary: '#F1F3F6', secondary: '#CBFE00', jersey: '#1A1A1A', letters: '#CBFE00',
    logo: 'img/logo-livewire-black.png', portrait: 'img/p1.jpg', model: 'models/varga.json', modelLo: 'models/varga-lo.json',
    player: {
      first: 'Nico', last: 'Varga', num: 3, pos: 'SG', height: 1.96,
      skin: '#b8835f', hair: { style: 'curly', color: '#1a120d' }, headband: '#111111',
      r: { three: 93, mid: 86, finish: 72, dunk: 52, handle: 80, speed: 82, defense: 70, block: 30, steal: 72 },
    },
  },
  {
    id: 'forge', city: 'Steel Valley', name: 'Forge', abbr: 'STV',
    primary: '#C8102E', secondary: '#2B2B2B', jersey: '#C41E35', letters: '#2B2B2B',
    logo: 'img/logo2.png', portrait: 'img/p2.jpg', model: 'models/aneke.json',
    player: {
      first: 'Chidi', last: 'Aneke', num: 34, pos: 'C', height: 2.13,
      skin: '#3d2519', hair: { style: 'twists', color: '#0d0907' }, beard: '#0d0907',
      r: { three: 45, mid: 62, finish: 92, dunk: 97, handle: 55, speed: 66, defense: 88, block: 96, steal: 50 },
    },
  },
  {
    id: 'wolves', city: 'North Peak', name: 'Wolves', abbr: 'NPK',
    primary: '#6FA8DC', secondary: '#1C2833', jersey: '#1F2F45', letters: '#8FC1EA',
    logo: 'img/logo3.png', portrait: 'img/p3.jpg', model: 'models/lindqvist.json',
    player: {
      first: 'Theo', last: 'Lindqvist', num: 21, pos: 'SF', height: 2.03,
      skin: '#e2b598', hair: { style: 'bun', color: '#c9a25a' }, beard: '#b48d4c',
      r: { three: 86, mid: 84, finish: 78, dunk: 72, handle: 72, speed: 74, defense: 80, block: 62, steal: 68 },
    },
  },
  {
    id: 'monarchs', city: 'Capital', name: 'Monarchs', abbr: 'CAP',
    primary: '#E0B000', secondary: '#111111', jersey: '#141414', letters: '#D9B76A',
    logo: 'img/logo4.png', portrait: 'img/p4.jpg', model: 'models/rourke.json',
    player: {
      first: 'Dante', last: 'Rourke', num: 1, pos: 'SG', height: 1.98,
      skin: '#6b4430', hair: { style: 'braids', color: '#0f0b09' },
      r: { three: 80, mid: 91, finish: 84, dunk: 82, handle: 86, speed: 86, defense: 72, block: 40, steal: 74 },
    },
  },
  {
    id: 'gators', city: 'Bayou', name: 'Gators', abbr: 'BYU',
    primary: '#1B5E20', secondary: '#FF8F00', jersey: '#23713A', letters: '#FF7A1A',
    logo: 'img/logo5.png', portrait: 'img/p5.jpg', model: 'models/kasumba.json',
    player: {
      first: 'Andre', last: 'Kasumba', num: 23, pos: 'PF', height: 2.06,
      skin: '#3a241a', hair: { style: 'buzz', color: '#0d0907' },
      r: { three: 62, mid: 74, finish: 88, dunk: 94, handle: 64, speed: 76, defense: 86, block: 84, steal: 62 },
    },
  },
  {
    id: 'surge', city: 'Neon City', name: 'Surge', abbr: 'NEO',
    primary: '#E0218A', secondary: '#00D1FF', jersey: '#16121c', letters: '#E0218A',
    logo: 'img/logo6.png', portrait: 'img/p6.jpg', model: 'models/holloway.json',
    player: {
      first: 'Jax', last: 'Holloway', num: 0, pos: 'PG', height: 1.85,
      skin: '#a8714f', hair: { style: 'twists', color: '#e7cf8a' },
      r: { three: 82, mid: 78, finish: 76, dunk: 46, handle: 97, speed: 96, defense: 68, block: 20, steal: 86 },
    },
  },
  {
    id: 'rangers', city: 'Redwood', name: 'Rangers', abbr: 'RDW',
    primary: '#7A1F2B', secondary: '#F2E3C6', jersey: '#7C2233', letters: '#F2E3C6',
    logo: 'img/logo7.png', portrait: 'img/p7.jpg', model: 'models/arata.json',
    player: {
      first: 'Kenji', last: 'Arata', num: 11, pos: 'SF', height: 2.01,
      skin: '#e0b28c', hair: { style: 'undercut', color: '#0f0c0b' },
      r: { three: 88, mid: 82, finish: 76, dunk: 70, handle: 76, speed: 78, defense: 82, block: 58, steal: 76 },
    },
  },
];

export function overall(p) {
  const r = p.r;
  const avg = (r.three + r.mid + r.finish + r.dunk * 0.5 + r.handle + r.speed + r.defense + r.block * 0.5 + r.steal) / 8;
  return Math.round(33 + avg * 0.7);
}

export function heightLabel(m) {
  const inches = Math.round(m / 0.0254);
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}

export const DIFFICULTY = {
  rookie:  { label: 'Rookie',  react: 0.42, shot: 0.80, speed: 0.90, steal: 0.35, contest: 0.55, iq: 0.45 },
  pro:     { label: 'Pro',     react: 0.30, shot: 0.95, speed: 0.96, steal: 0.60, contest: 0.75, iq: 0.65 },
  allstar: { label: 'All-Star', react: 0.21, shot: 1.05, speed: 1.00, steal: 0.85, contest: 0.90, iq: 0.82 },
  legend:  { label: 'Legend',  react: 0.13, shot: 1.15, speed: 1.03, steal: 1.10, contest: 1.00, iq: 0.95 },
};
