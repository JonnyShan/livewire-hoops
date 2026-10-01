# Hoops 1v1

Live at **https://livewire.hoops.gamify.com**. This repo is the hosted copy (GitHub Pages). The source lives in [JonnyShan/Multi-View-Screen](https://github.com/JonnyShan/Multi-View-Screen) under `hardwood/`; this copy is from commit `bbd16b3`.

A 1-on-1 half-court basketball game for phones, built with three.js. Open `index.html` from any static web server.

## What's in it

- **Arena**: a 3D half court with glossy floor reflections, a verlet-cloth net, a rim and glass that the ball physically bounces off, LED boards and a shot clock. The hardwood is a photo texture.
- **Lighting**: everything is lit and reflected by a 360° photo of a packed arena (`img/arena-360.jpg`, see `js/look.js`); its floodlights are boosted back to HDR brightness so they read as real overhead light. The same photo shows through above the lower bowl. Each player casts a shadow and has soft contact shadows under both shoes. A broadcast colour grade (firmer contrast, cool shadows, warm highlights) is built into the tone mapper, so it costs nothing extra on phones.
- **Crowd**: a tiered bowl of about 2,200 fans around the half court (`js/crowd.js`). Each fan is a photographed card with a seated and a cheering frame (`img/fans.webp`, 40 different fans, mirrored for variety), all drawn in one instanced call. The crowd rises when you shoot a three, jumps to its feet and bounces when you score, sits back down after a miss, and goes quiet when the CPU scores. Camera flashes go off with the excitement.
- **Branding**: Livewire (livewire.group). Both players wear Livewire kits: you (Morrow, #7) in yellow, the CPU (Varga, #3) in black. The arena boards, court and UI use Livewire's yellow `#CBFE00` and black, its wordmark and its mark (`BRAND` in `js/data.js`, `img/logo-livewire*.png`, `img/livewire-mark.png`). The kits, portraits and cover were regenerated with Higgsfield, using Livewire's wordmark as the reference for the chest lettering.
- **Players**: two fictional players. Each body is a textured, rigged 3D model (about 94,000 triangles) made from a generated full-body photo. Models ship as glTF JSON (quantised geometry) plus JPEG maps (`models/`): colour, a surface-detail normal map and a roughness map, both derived from the colour texture. The jersey hem and shorts carry per-vertex cloth weights, so they trail the body, drop and lift on jumps, and flutter at speed. On the Low quality setting the lighter 31,000-triangle bodies (`models/*-lo.*`) are used. If a model fails to load, a built-in body is used instead. The data for six more players is still in `js/data.js`, but there is no picker for now.
- **Motion**: running, walking, backpedalling, defensive slides, stances and jumps come from motion-capture clips (`models/motion.json`). The clips are blended by speed and direction and retargeted onto each body. A procedural rig handles what the library doesn't cover: dribbling, shooting, layups, dunks, steals, and arm IK that keeps the hands on the ball.
- **Gameplay**: timed jump shots with a release meter, layups and dunks, crossovers, spins and step-backs, steals, blocks, rebounds, a 12-second shot clock, clearing the ball, and games to 11. The front screen has one button: Start.
- **Audio** (`sfx/`): the crowd is all crowd, with no single voices:
  - an arena crowd bed that gets louder while a three is in the air and falls away after a miss or when the CPU scores
  - two layered crowd roars when you score, which get bigger on threes and dunks
  - heavy rim clanks, built from real recordings of a basketball hitting a gym rim and a steel hoop being struck
  - the net swish, the backboard bang, the dribble and the dunk slam

  Sneaker squeaks and the buzzer are still synthesised with WebAudio. If a sound file fails to load, a synthesised version plays instead.

## Controls

| Action | Touch | Keyboard |
| --- | --- | --- |
| Move | Drag on the left half; push to the edge to sprint | WASD / arrows, Shift to sprint |
| Shoot / Block / Jump | Big orange button: hold, then release at the top of the jump | J or Space |
| Move / Steal | Grey button | K |
| Pause | Top-left button | — |

## Files

- `js/main.js`: renderer, quality tiers, menus, camera, loop
- `js/game.js`: rules, possessions, shooting model, moves, steals, blocks, HUD
- `js/ai.js`: CPU offense and defense
- `js/player.js`: procedural rig and animation, IK, and retargeting onto the skinned models
- `js/motion.js`: the motion-capture layer (clip blending by speed and direction, jump time-warping)
- `js/ball.js`: ball physics and the net cloth
- `js/arena.js`: court, markings, reflections, LED boards, hoop
- `js/crowd.js`: the seating bowl and the animated crowd
- `js/look.js`: arena lighting from the 360° photo, and the colour grade
- `js/audio.js`: sound playback (recorded crowd and ball sounds, synthesised fallbacks)
- `js/input.js`, `js/data.js`

## Art and sound

The images and models were generated with Higgsfield: the hardwood texture, team logos, player portraits, cover art, and the player models (full-body reference, then image-to-3D with auto-rigging). The motion clips come from the Higgsfield (Meshy) animation library. They were baked to per-bone rotation deltas by `raw/hardwood/anim/convert_clips.py`, which is kept outside the repo. All teams and players are fictional.

The arena panorama and the fans were generated with Higgsfield. The fan sheets were cut out and packed by `raw/hardwood/gfx/fans_atlas.py`, and the panorama was reprojected by `raw/hardwood/gfx/pano2equirect.py` (both kept outside the repo).

The crowd and rim sounds are real recordings from Freesound, all CC0 (public domain): FC St. Pauli stadium crowd reactions (itmightgetloud, #829453), a roaring crowd (benfree, #130568), fans at a basketball game (phillyfan972, #412160), Rogers Arena game atmosphere (SEF7, #706497), basketball shots in a gym (kyles, #450722), a steel basketball hoop being struck (jimmyfisher, #402662) and missed shots off a gym rim (amsaenz03, #788261). The swish, backboard, dribble and dunk were generated with ElevenLabs.
