// Presentation: turns the game's events into sound, crowd, callouts, tags,
// vibration and camera shake, and draws the HUD (score bug, clocks, status,
// shot meter, the ring under your player, the pass target, the hot ball).
// The game never touches any of this directly, so an online client could
// drive the same presentation from a host's events.
import * as THREE from 'three';
import { GATHER, AIR, T_FULL, M_APEX, SHOT_CLOCK } from './game.js';
import { BRAND } from './data.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Presenter {
  constructor({ sound, arena, scene, camera, cam, vib, teams, ball }) {
    Object.assign(this, { sound, arena, scene, camera, cam, vib, teams, ball });
    this.el = {
      callout: $('callout'), tag: $('tag'), status: $('status'), meter: $('meter'), fill: $('meterFill'), win: $('meterWin'),
      ptsL: $('ptsL'), ptsR: $('ptsR'), hasL: $('hasL'), hasR: $('hasR'), clock: $('gameClock'), shot: $('shotClock'),
      dunkRing: $('dunkRing'), dunkProg: $('dunkProg'),
    };
    this.dunkShown = -1;
    // your ring, and a smaller one under the teammate a pass would go to
    const ring = (r0, r1, color, op) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false, toneMapped: false }));
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 2;
      scene.add(m);
      return m;
    };
    this.ring = ring(0.42, 0.5, teams[0].primary, 0.75);
    this.target = ring(0.3, 0.36, '#ffffff', 0.5);
    this.target.visible = false;
    this.t = 0;
    this.statusFlash = 0;
    this.hotGlow = 0;
    // the ball glows Livewire yellow when it's in a hot hand
    const m = ball.mesh.material;
    m.emissive = new THREE.Color(BRAND.yellow);
    m.emissiveIntensity = 0;
  }

  dispose() {
    for (const m of [this.ring, this.target]) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.ball.mesh.material.emissiveIntensity = 0;
  }

  pan(x) { return clamp(x / 7, -0.8, 0.8); }
  // quieter at the far end of the floor
  near(x, z) { const c = this.camera.position; return clamp(1.3 - Math.hypot(x - c.x, z - c.z) / 28, 0.35, 1); }

  // replays draw the recorded play: no live rings or glow over it
  setHidden(on) {
    this.hidden = on;
    if (on) { this.ring.visible = this.target.visible = false; this.ball.mesh.material.emissiveIntensity = 0; }
  }
  last(g, i) { return g.players[i].info.last; }
  home(g, team) { return team === 0; }
  vibrate(ms) { if (this.vib() && navigator.vibrate) try { navigator.vibrate(ms); } catch (e) { /* ignore */ } }

  callout(text, sub = '') {
    const el = this.el.callout;
    el.innerHTML = text + (sub ? `<small>${sub}</small>` : '');
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  tag(text, color, worldPos) {
    const el = this.el.tag;
    el.textContent = text;
    el.style.background = color;
    el.style.color = color === '#3ce07a' || color === '#ffd23f' ? '#081208' : '#fff';
    const s = this.project(worldPos);
    el.style.left = s.x + 'px';
    el.style.top = s.y + 'px';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  project(v) {
    _v2.copy(v).project(this.camera);
    return { x: (_v2.x * 0.5 + 0.5) * window.innerWidth, y: (-_v2.y * 0.5 + 0.5) * window.innerHeight };
  }

  overHead(g, i, up = 0.45) { return g.players[i].headWorld(new THREE.Vector3()).add(_v.set(0, up, 0)); }

  // ---------- events from the game ----------
  handle(type, d, g) {
    const S = this.sound, A = this.arena;
    const teamOf = (i) => g.teamOf(i);
    switch (type) {
      case 'tipset':
        this.callout(d.overtime ? 'Sudden death' : 'Tip-off', d.overtime ? 'Next basket wins' : '2:00 game · 3 on 3');
        if (A) A.buzzer(false);
        break;
      case 'toss': S.whoosh(); break;
      case 'tip': S.dribble(1.2, 0); break;
      case 'shotstart':
        S.whoosh();
        if (d.three) { S.threeUp(teamOf(d.i) === 0); A.rise(teamOf(d.i) === 0); }   // the building gets loud for threes
        break;
      case 'release': {
        if (g.isUser(d.i)) {
          const label = d.timing === 'perfect' ? 'PERFECT' : d.timing === 'good' ? (d.early ? 'SLIGHTLY EARLY' : 'SLIGHTLY LATE') : d.early ? 'EARLY' : 'LATE';
          const col = d.timing === 'perfect' ? '#3ce07a' : d.timing === 'good' ? '#ffd23f' : '#ff3b2f';
          this.tag(label, col, this.overHead(g, d.i));
          if (d.timing === 'perfect') this.vibrate(18);
        }
        break;
      }
      case 'block': {
        const home = teamOf(d.i) === 0;
        S.dribble(2.5); S.cheer(0.9, home); A.cheer(0.8, home);
        this.callout('Blocked', this.last(g, d.i));
        this.vibrate(30);
        this.cam.shake = 0.6;
        break;
      }
      case 'move': {
        const p = g.players[d.i].pos;
        S.squeak(this.pan(p.x));
        if (g.isUser(d.i)) this.tag(d.label, 'rgba(10,12,18,.8)', this.overHead(g, d.i, 0.4));
        break;
      }
      case 'bite': {
        const home = teamOf(d.i) === 0;
        A.cheer(0.4, home); S.cheer(0.4, home);
        if (d.ankles) this.callout('Ankles', `${this.last(g, d.i)} breaks ${this.last(g, d.j)}`);
        break;
      }
      case 'steal': case 'intercept': {
        const home = teamOf(d.i) === 0;
        const p = g.players[d.i].pos;
        S.dribble(1.5, this.pan(p.x));
        this.callout(type === 'steal' ? 'Stolen' : 'Picked off', this.last(g, d.i));
        A.cheer(0.6, home); S.cheer(0.5, home);
        if (home) this.vibrate(25);
        break;
      }
      case 'dunkready':
        if (d.team === 0) this.vibrate([18, 60, 18]);
        break;
      case 'deflect': S.dribble(1.1, this.pan(g.players[d.i].pos.x)); break;
      case 'pass': S.dribble(0.35, this.pan(g.players[d.i].pos.x)); break;
      case 'catch': S.dribble(0.55, this.pan(g.players[d.i].pos.x)); break;
      case 'dribble': case 'bounce': S.dribble(d.v * this.near(d.x, d.z), this.pan(d.x)); break;
      case 'squeak': if (this.near(d.x, d.z) > 0.55) S.squeak(this.pan(d.x)); break;
      case 'rim': S.rim(d.v * this.near(d.x, d.z), this.pan(d.x)); break;
      case 'board': S.board(d.v * this.near(d.x, d.z), this.pan(d.x)); break;
      case 'slam':
        this.cam.shake = d.big ? 1.5 : 1.25;
        this.vibrate(60);
        S.dunk(this.pan(g.rimOf(d.i).x));
        break;
      case 'score': {
        const home = d.team === 0;
        S.swish(d.clean);
        const big = d.type === 'dunk' ? 1.4 : d.pts === 3 ? 1.1 : 0.7;
        S.made(home, big);
        A.cheer(big, home);
        let title = d.type === 'dunk' ? (d.big ? 'Monster slam' : 'Slam') : d.pts === 3 ? 'From deep' : d.clean ? 'Swish' : 'Bucket';
        if (d.type === 'layup') title = d.board ? 'Off the glass' : 'Layup';
        if (d.buzzer) title = 'At the buzzer';
        if (d.winning) title = d.buzzer ? 'Buzzer beater' : 'Game';
        this.callout(title, `${this.last(g, d.i)} +${d.pts}`);
        break;
      }
      case 'miss':
        if (d.air) this.callout('Air ball');
        S.missed(d.team === 0);
        A.settle();
        break;
      case 'turnover':
        S.buzzer();
        this.callout(d.why, `${this.teams[d.team].abbr} ball`);
        break;
      case 'offreb': this.callout('Offensive board', this.last(g, d.i)); break;
      case 'hot': {
        const home = teamOf(d.i) === 0;
        this.callout('On fire', `${this.last(g, d.i)} is hot`);
        S.cheer(1.1, home); A.cheer(1.0, home);
        if (home) this.vibrate([20, 40, 20]);
        break;
      }
      case 'cool': if (teamOf(d.i) === 0) this.callout('Cooled off', this.last(g, d.i)); break;
      case 'buzzer': S.buzzer(); A.buzzer(true); break;
      case 'overtime': this.callout('Tied', 'Sudden death: next basket wins'); break;
      case 'inbound': A.buzzer(false); break;
      case 'end': {
        const home = d.winner === 0;
        setTimeout(() => S.buzzer(), 300);
        A.buzzer(true);
        A.cheer(1.5, home);
        S.cheer(1.5, home);
        break;
      }
      case 'switch': this.ringPulse = 1; break;
      default: break;
    }
  }

  // ---------- every frame ----------
  frame(dt, g) {
    this.t += dt;
    this.sound.update(dt);
    // score bug
    const E = this.el;
    if (E.ptsL.textContent !== String(g.score[0])) E.ptsL.textContent = g.score[0];
    if (E.ptsR.textContent !== String(g.score[1])) E.ptsR.textContent = g.score[1];
    E.hasL.classList.toggle('on', g.poss === 0);
    E.hasR.classList.toggle('on', g.poss === 1);
    const c = g.clock;
    const clock = g.overtime ? 'OT' : c >= 10 ? `${Math.floor(Math.ceil(c) / 60)}:${String(Math.ceil(c) % 60).padStart(2, '0')}` : c.toFixed(1);
    if (E.clock.textContent !== clock) E.clock.textContent = clock;
    E.clock.classList.toggle('low', !g.overtime && c < 10);
    const resting = g.state === 'tip' || g.state === 'inbound' || g.state === 'dead';
    const sc = resting ? String(SHOT_CLOCK) : String(Math.max(0, Math.ceil(g.shotClock)));
    if (E.shot.textContent !== sc) E.shot.textContent = sc;
    this.arena.setShotClock(sc, true);
    // status line
    let status = '';
    if (g.overtime && !g.over) status = 'SUDDEN DEATH · NEXT BASKET WINS';
    else if (g.hot[0] >= 0 && !g.over) status = `${g.players[g.hot[0]].info.last.toUpperCase()} IS ON FIRE`;
    else if (!g.over && c < 10 && c > 0 && g.score[0] <= g.score[1]) status = g.score[0] === g.score[1] ? 'TIED · LAST SECONDS' : 'LAST SECONDS';
    if (status) { if (E.status.textContent !== status) E.status.textContent = status; E.status.classList.add('on'); }
    else E.status.classList.remove('on');
    // the dunk meter around SHOOT: it fills over 15 seconds of play, then reads DUNK
    const dm = Math.round(g.dunkMeter[0] * 500) / 500;
    if (dm !== this.dunkShown) {
      this.dunkShown = dm;
      E.dunkProg.style.strokeDashoffset = String(100 * (1 - dm));   // pathLength 100 (index.html)
      E.dunkProg.classList.toggle('empty', dm <= 0);
      E.dunkRing.classList.toggle('full', dm >= 1);
    }
    // your ring (it pulses when you switch), and the pass target under a teammate
    const u = g.user;
    this.ringPulse = Math.max(0, (this.ringPulse || 0) - dt * 3);
    if (u >= 0 && !g.over) {
      const me = g.players[u];
      this.ring.visible = true;
      this.ring.position.set(me.pos.x, 0.006, me.pos.z);
      const hot = g.hot[0] === u;
      this.ring.material.color.set(hot ? '#ff8a1f' : this.teams[0].primary);
      this.ring.material.opacity = 0.55 + 0.2 * Math.sin(this.t * 4) + 0.25 * this.ringPulse;
      this.ring.scale.setScalar(1 + 0.35 * this.ringPulse);
    } else this.ring.visible = false;
    const tg = g.passTarget;
    if (tg >= 0 && !g.over) {
      const q = g.players[tg].pos;
      this.target.visible = true;
      this.target.position.set(q.x, 0.006, q.z);
      this.target.material.opacity = 0.35 + 0.15 * Math.sin(this.t * 6);
    } else this.target.visible = false;
    // the hot ball
    const hotTeam = g.handler >= 0 ? g.teamOf(g.handler) : g.shot ? g.shot.team : -1;
    const holder = g.handler >= 0 ? g.handler : g.shot ? g.shot.shooter : -1;
    const glowing = hotTeam >= 0 && holder >= 0 && g.hot[hotTeam] === holder;
    this.hotGlow += ((glowing ? 1 : 0) - this.hotGlow) * (1 - Math.exp(-dt * 6));
    this.ball.mesh.material.emissiveIntensity = this.hotGlow * (0.55 + 0.25 * Math.sin(this.t * 14));
    // shot meter over your shooter
    const p = u >= 0 ? g.players[u] : null;
    const act = p && p.action;
    if (act && act.type === 'shoot' && g.shot && g.shot.shooter === u && act.t < GATHER + AIR + 0.2) {
      const s = this.project(p.headWorld(_v).add(_v2.set(0, 0.1, 0)));
      E.meter.style.left = (s.x + 34) + 'px';
      E.meter.style.top = (s.y - 60) + 'px';
      const m = clamp(act.t / T_FULL, 0, 1);
      E.fill.style.height = (m * 100) + '%';
      E.win.style.bottom = ((M_APEX - act.win / 2) * 100) + '%';
      E.win.style.height = (act.win * 100) + '%';
      E.meter.classList.add('on');
    } else E.meter.classList.remove('on');
  }
}

