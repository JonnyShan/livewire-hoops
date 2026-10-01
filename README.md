# Hoops 1v1

Live at **https://livewire.hoops.gamify.com**. This repo is the hosted copy (GitHub Pages). The source lives in [JonnyShan/Multi-View-Screen](https://github.com/JonnyShan/Multi-View-Screen) under `hardwood/`; this copy is from commit `4b01626`.

A 1-on-1 half-court basketball game for phones, built with three.js. Open `index.html` from any static web server.

## What's in it

- **Arena**: a 3D half court with glossy floor reflections, a verlet-cloth net, a rim and glass that the ball physically bounces off, LED boards and a shot clock. The hardwood is a photo texture.
- **Lighting**: everything is lit and reflected by a 360° photo of a packed arena (`img/arena-360.webp`, see `js/look.js`; phones get a 2k copy); its floodlights are boosted back to HDR brightness so they read as real overhead light. The same photo shows through above the lower bowl. Each player casts a shadow and has soft contact shadows under both shoes. A broadcast colour grade (firmer contrast, cool shadows, warm highlights) is built into the tone mapper, so it costs nothing extra on phones.
- **Crowd**: a tiered bowl of about 2,200 fans around the half court (`js/crowd.js`). Each fan is a photographed card with a seated and a cheering frame (`img/fans.webp`, 40 different fans, mirrored for variety), all drawn in one instanced call. The crowd rises when you shoot a three, jumps to its feet and bounces when you score, sits back down after a miss, and goes quiet when the CPU scores. Camera flashes go off with the excitement.
- **Branding**: Livewire (livewire.group). Both players wear Livewire kits: you (Morrow, #7) in yellow, the CPU (Varga, #3) in black. The arena boards, court and UI use Livewire's yellow `#CBFE00` and black, its wordmark and its mark (`BRAND` in `js/data.js`, `img/logo-livewire*.png`, `img/livewire-mark.png`). The kits, portraits and cover were regenerated with Higgsfield, using Livewire's wordmark as the reference for the chest lettering.
- **Players**: two fictional players. Each body is a textured, rigged 3D model (about 94,000 triangles) made from a generated full-body photo. Models ship as meshopt-compressed glTF binaries (`models/*.glb`, about 1.1 MB each) plus WebP maps: colour, a surface-detail normal map and a roughness map, both derived from the colour texture. Where WebAssembly is blocked (strict content-security policies), the uncompressed glTF JSON (`models/*.json`) is loaded instead. The jersey hem and shorts carry per-vertex cloth weights, so they trail the body, drop and lift on jumps, and flutter at speed. On the Low quality setting the lighter 31,000-triangle bodies (`models/*-lo.*`) are used. If a model fails to load, a built-in body is used instead. The data for six more players is still in `js/data.js`, but there is no picker for now.
- **Motion**: running, walking, backpedalling, defensive slides, stances and jumps come from motion-capture clips (`models/motion.json`). The clips are blended by speed and direction and retargeted onto each body. A procedural rig handles what the library doesn't cover: dribbling, shooting, layups, dunks, steals, and arm IK that keeps the hands on the ball.
- **Replays**: when you hit a three or a dunk, the game cuts to a slow-motion replay from broadcast angles (tap to skip). It is recorded as a branded video clip with the crowd sound; tap **Share clip** in the HUD, or **Share** on the end screen, to share it or save it (`js/replay.js`). Sharing needs HTTPS and a browser with file sharing; otherwise the clip downloads.
- **Loading and frame rate**: a loading screen shows while the models, motion and sounds download (`js/progress.js`), then fades to the title. It has the Livewire game ball turning slowly (a 10-second seamless loop, `img/ball.mp4` with a WebM fallback, about 230 KB; its first frame `img/ball.webp` shows straight away), a thin progress bar, and the Livewire wordmark at the bottom. Video plays off the main thread, so the ball keeps turning while the 3D setup is busy. On the Auto quality setting, the render resolution steps between 70% and 100% in 5% steps to hold 60 fps. Phones slow down as they warm up, so it steps down when a 2-second stretch falls below 57 fps. It steps back up after 6 seconds at 59 fps or more, but doesn't retry a resolution that just failed for a minute.
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

## Testing on a phone

Add `?debug` to the address (for example `https://livewire.hoops.gamify.com/?debug`) to show a performance panel. It shows:

- the frame rate and the worst recent frame
- the quality and render scale that Auto chose
- the session's average frame rate, 1% low, hitches and frame rate every 10 seconds, which shows a phone slowing as it heats up
- replay frame rate and whether a clip was recorded
- load and start times, and how much was downloaded
- whether the loading ball video played, and the audio state
- the device and GPU

While you play, the panel shows only the essentials. Pause the game or reach the end screen to see everything. **Copy report** copies the full details, including the frame-time histogram and when the long frames happened.

**Bench** starts a fresh CPU-vs-CPU game and measures 6 seconds each of:

- the game as is
- no shadows
- no floor reflection
- the players left out of the reflection
- no crowd
- 70% resolution
- the game as is again, to show whether the phone slowed down as it warmed up

Bench runs for about 45 seconds and shows a countdown on its button. Copy is off until it finishes. Leaving Safari or pausing stops it. Each result shows the frame rate and how long the game's script took per frame. If switching something off raises the frame rate, that is what the phone is short of. If the script time is close to the frame time, the CPU is the limit rather than the GPU.

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
- `js/replay.js`: highlight recording, replay cameras, and the shareable video clip
- `js/progress.js`: download progress for the Start button
- `js/debug.js`: the `?debug` performance panel
- `js/audio.js`: sound playback (recorded crowd and ball sounds, synthesised fallbacks)
- `js/input.js`, `js/data.js`

## Art and sound

The images and models were generated with Higgsfield: the hardwood texture, team logos, player portraits, and the player models (full-body reference, then image-to-3D with auto-rigging). The motion clips come from the Higgsfield (Meshy) animation library. They were baked to per-bone rotation deltas by `raw/hardwood/anim/convert_clips.py`, which is kept outside the repo. All teams and players are fictional.

The title image (`img/cover.webp`), a dunk seen from behind so no face shows, was supplied by the project owner. The title text baked into it was removed with OpenCV inpainting, so the page's own title sits on top. The arena panorama and the fans were generated with Higgsfield. So was the loading-screen ball: a still made with GPT Image 2.5 (with Livewire's wordmark as the reference), turned into a 360° spin with MiniMax H3 (same first and last frame), then re-timed to an even speed with motion interpolation so it loops without a pause. The fan sheets were cut out and packed by `raw/hardwood/gfx/fans_atlas.py`, and the panorama was reprojected by `raw/hardwood/gfx/pano2equirect.py` (both kept outside the repo).

The crowd and rim sounds are real recordings from Freesound, all CC0 (public domain): FC St. Pauli stadium crowd reactions (itmightgetloud, #829453), a roaring crowd (benfree, #130568), fans at a basketball game (phillyfan972, #412160), Rogers Arena game atmosphere (SEF7, #706497), basketball shots in a gym (kyles, #450722), a steel basketball hoop being struck (jimmyfisher, #402662) and missed shots off a gym rim (amsaenz03, #788261). The swish, backboard, dribble and dunk were generated with ElevenLabs.
