// Full-court geometry. Units are metres.
// Court frame: baseline A at z = 0, centre line at z = 14.33, baseline B at
// z = 28.66, x = lateral. Basket A (near z = 0) is the far end of the screen:
// your team (team 0) attacks it, so you always play up the screen. Team 1
// attacks basket B (near z = 28.66), the end nearest the camera.
//
// Each team also has its own "frame": the court turned so the basket it attacks
// sits at (0, rimZ) and its own basket at (0, len - rimZ). Team 0's frame is the
// court frame; team 1's is the court turned half a turn (x -> -x, z -> len - z).
// Rules and AI written once in a team's frame work for both teams.
import * as THREE from 'three';

export const COURT = {
  halfW: 7.62,           // sideline x
  halfLen: 14.33,        // centre line z
  len: 28.66,            // baseline B z
  rimY: 3.048,
  rimZ: 1.575,           // rim centre from its own baseline
  rimR: 0.2286,          // inner radius
  rimTube: 0.009,
  boardZ: 1.22,          // backboard front face from its own baseline
  boardW: 1.83,
  boardBottom: 2.90,
  boardH: 1.067,
  threeR: 7.24,
  cornerX: 6.71,
  cornerZ: 4.295,
  keyW: 4.88,
  ftZ: 5.79,
  circleR: 1.83,         // centre circle
};

// basket b: 0 = A (attacked by team 0), 1 = B (attacked by team 1).
// dir is the way into the court from that basket's baseline.
export const BASKETS = [
  { i: 0, dir: 1, baseZ: 0, rim: new THREE.Vector3(0, COURT.rimY, COURT.rimZ) },
  { i: 1, dir: -1, baseZ: COURT.len, rim: new THREE.Vector3(0, COURT.rimY, COURT.len - COURT.rimZ) },
];
// basket A's rim, for code that only ever looks at your end (replays)
export const RIM = BASKETS[0].rim;

// the basket team t attacks, and the one it defends
export const attackBasket = (t) => BASKETS[t];
export const homeBasket = (t) => BASKETS[1 - t];

// court <-> team frame (the same turn both ways)
export function toFrame(t, x, z, out = { x: 0, z: 0 }) {
  if (t === 0) { out.x = x; out.z = z; } else { out.x = -x; out.z = COURT.len - z; }
  return out;
}
export const fromFrame = toFrame;

// is (x, z) a three when shooting at basket b?
export function isThree(x, z, b = 0) {
  if (b === 1) { x = -x; z = COURT.len - z; }
  if (z < COURT.cornerZ) return Math.abs(x) > COURT.cornerX;
  return Math.hypot(x, z - COURT.rimZ) > COURT.threeR;
}

export function inBounds(x, z, margin = 0) {
  return Math.abs(x) <= COURT.halfW + margin && z >= -margin && z <= COURT.len + margin;
}
