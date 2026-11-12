/*
 * Brand for this page, before anything else runs (a classic script in <head>).
 * Gamify is the core brand; every other brand, Livewire included, is a pack in brands/<id>/brand.json laid
 * over it (README, "Brand packs"). Which brand: ?brand=<id> in the address, else the site's own brand
 * (HOST_BRANDS), else Gamify. Sets window.HOOPS_BRAND and the CSS colour tokens; js/data.js reads the rest.
 */
(function () {
  var CORE = {
    id: 'gamify',
    name: 'Gamify',
    accent: '#1F82D0', accentHi: '#5AA8E4', onAccent: '#FFFFFF',
    logoStyle: 'image',                 // 'image': the logo file below; 'grid': the wordmark path with Livewire's 4x4 mark
    logo: 'img/gamify-logo-white.svg',  // white (multicolour mark allowed) on transparent
    mark: 'img/gamify-mark.png',        // centre court and boards, drawn as it is
    cover: 'img/cover.webp',            // title picture
    ball: 'img/ball.webp',              // loading-screen ball
    ballVideo: null,
    fans: 'img/fans.webp',
    textures: null,                     // null: the player textures in models/ as they are
    url: 'demos.gamify.com/basketball', share: 'Gamify Hoops',
    kitWords: ['blue', 'graphite'],     // what the rules call your kit and the CPU's
    teams: [
      { id: 'gamify', name: 'Gamify', abbr: 'BLUE', primary: '#1F82D0', secondary: '#1A1A1A', jersey: '#1F82D0', letters: '#FFFFFF', logo: 'img/logo-gamify.png' },
      { id: 'gamify-graphite', name: 'Gamify', abbr: 'GRAPHITE', primary: '#F1F3F6', secondary: '#1F82D0', jersey: '#2B2D31', letters: '#1F82D0', logo: 'img/logo-gamify-graphite.png' },
    ],
  };
  var HOST_BRANDS = { 'livewire.hoops.gamify.com': 'livewire' };

  function rgb(h) { h = h.replace('#', ''); return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); }); }
  function hex(c) { return '#' + c.map(function (v) { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); }).join('').toUpperCase(); }
  function mix(a, b, t) { var x = rgb(a), y = rgb(b); return hex(x.map(function (v, i) { return v + (y[i] - v) * t; })); }
  function lum(h) { var c = rgb(h); return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  function pack(id) {
    try { var x = new XMLHttpRequest(); x.open('GET', 'brands/' + id + '/brand.json', false); x.send();
      return x.status >= 200 && x.status < 300 ? JSON.parse(x.responseText) : null; } catch (e) { return null; }
  }

  var q = new URLSearchParams(location.search).get('brand');
  var id = q && /^[a-z0-9][a-z0-9-]{0,39}$/.test(q) ? q : HOST_BRANDS[location.hostname] || CORE.id;
  var B = CORE;
  if (id !== CORE.id) {
    var p = pack(id);
    if (!p) console.warn('brand "' + id + '" not found, showing ' + CORE.id);
    else {
      var dir = 'brands/' + id + '/', f = function (v) { return v ? dir + v : null; };
      var a = p.accent || CORE.accent, name = p.name || id, on = p.onAccent || (lum(a) > 0.6 ? '#1A1A1A' : '#FFFFFF');
      var logo = f(p.logo), mark = f(p.mark) || logo;
      B = {
        id: id, name: name, accent: a, accentHi: p.accentHi || mix(a, '#FFFFFF', 0.3), onAccent: on,
        logoStyle: p.logoStyle || 'image', logo: logo, mark: mark, wordmark: p.wordmark || null,
        cover: f(p.cover), ball: f(p.ball) || 'img/ball-plain.webp', ballVideo: p.ballVideo ? p.ballVideo.map(f) : null,
        fans: f(p.fans), textures: p.textures ? dir + p.textures : 'neutral',
        url: p.url || location.host + location.pathname.replace(/\/$/, '') + '/?brand=' + id, share: p.share || name + ' Hoops',
        kitWords: p.kitWords || ['', ''],
        teams: [0, 1].map(function (i) {
          var t = (p.teams || [])[i] || {}, you = i === 0;
          return { id: t.id || id + (you ? '' : '-dark'), name: t.name || name, abbr: t.abbr || (you ? name.slice(0, 5).toUpperCase() : 'DARK'),
            primary: t.primary || (you ? a : '#F1F3F6'), secondary: t.secondary || (you ? '#1A1A1A' : a),
            jersey: t.jersey || (you ? a : '#2B2D31'), letters: t.letters || (you ? on : a), logo: f(t.logo) || mark };
        }),
      };
    }
  }
  window.HOOPS_BRAND = B;
  var r = document.documentElement.style;
  r.setProperty('--leather', B.accent); r.setProperty('--leather-hi', B.accentHi); r.setProperty('--on-leather', B.onAccent);
  r.setProperty('--leather-rgb', rgb(B.accent).join(','));
  r.setProperty('--cover', B.cover ? 'url("' + B.cover + '")' : 'none');
  r.setProperty('--ball', 'url("' + B.ball + '")');
  document.title = B.name + ' Hoops';
})();
