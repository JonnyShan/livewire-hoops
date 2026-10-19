# Livewire Hoops

Live at **https://livewire.hoops.gamify.com**: the 3-on-3 full-court game. This repo is the hosted copy (GitHub Pages). The source lives in [JonnyShan/Multi-View-Screen](https://github.com/JonnyShan/Multi-View-Screen) under `hoops3v3/`; this copy is from commit `49122a4`.

- `/` (the repo root): Hoops 3v3.
- `/3v3/` (`3v3/`): the same 3v3 build, so earlier preview links keep working.
- `/1v1/` (`1v1/`): the original 1-on-1 half-court game, from `hardwood/` in the source repo.

A 3-on-3 full-court arcade basketball game for phones, built with three.js. Open `index.html` from any static web server.

The 1-on-1 half-court game it grew from stays playable at https://livewire.hoops.gamify.com/1v1/ (`1v1/`).

## What's in it

- **The game**: three on three, full court, one 2-minute game.
  - You're Livewire yellow and always attack up the screen. The CPU is Livewire black.
  - 2s and 3s, a 14-second shot clock, and no fouls or violations besides the shot clock and out of bounds.
  - It starts with a tip-off at centre court.
  - After a basket, the other team inbounds from under that basket. After a turnover, they inbound from the sideline or baseline where the ball went out.
  - The game clock runs only while the ball is live. It stops on dead balls and inbounds until the pass is caught.
  - A shot in the air at the buzzer still counts.
  - A tie goes to sudden death: a new tip-off, and the next basket wins.
- **Arcade**:
  - **Dunk meter**: dunks are earned. A ring around SHOOT fills over 15 seconds of play (it stops while paused and during replays) and reads DUNK when it's full. Then run at the rim and press SHOOT from up to 4.2 m out (about the free-throw line): any player goes up well over the rim and throws it down, with more hang time from a longer take-off, slow motion and a bigger camera shake. The dunk empties the ring. Without it, drives finish as layups. Your teammates leave the meter for you; the CPU team fills and spends its own.
  - **Hot hand**: score three in a row while the other team doesn't, and you're on fire until they score. You shoot better, your release window is wider, and the ball glows Livewire yellow.
  - Defenders can swat a jump shot on its way up.
- **Control**: you always play the man with the ball. When you pass, you take over the man it's thrown to.
  - On defence you play the man nearest the ball when you lose it. SWITCH jumps to the teammate nearest the ball.
  - A yellow ring marks your player. A white ring marks the teammate a pass would go to: the one the stick points at, or else the most open.
  - Passes are led to where the receiver is running. Defenders in the lane can pick them off or get a fingertip on them. Long passes, and inbounds over a defender, are lobbed.
- **Team AI** (`js/ai.js`):
  - On offence it pushes the ball up the floor, fills the lanes on the break, spaces the floor at the corners, wings and slots, and cuts (give-and-go and backdoor). It makes the extra pass to an open man, picks its shots, and crashes the glass or gets back.
  - On defence it plays man-to-man, with matchups chosen for the least running. It sags off the ball, steps in to help on a drive, closes out on shooters, jumps passing lanes and boxes out.
  - Your two teammates use the same AI.
- **Built to go online later**:
  - The game (`js/game.js`) is the simulation only. Every player is driven the same way, through its stick intent and commands (`cmdShoot`, `cmdPass`, `cmdMove`, `cmdSteal`, `cmdContest`), whether the user, the AI or a remote player sends them.
  - What it wants seen or heard goes out as events to the presentation (`js/present.js`): sound, crowd, callouts, rings, the HUD.
  - Its dice come from a seeded generator, so the same seed and inputs replay the same game.
- **Arena**: a 3D full court with two hoops whose rims and glass the ball physically bounces off, a cloth net on each, glossy floor reflections and LED boards. The hardwood is a photo texture.
  - Both shot clocks show the time on both faces.
  - Basket B's post and arm fade out while the camera is behind them.
  - The key light's shadow follows the play.
- **Camera**: portrait, with the court running up the screen. It rides behind the play and follows the ball along the floor. When the CPU attacks toward you, it rises and looks down on the play from behind basket B.
- **Crowd**: a bowl of about 3,800 fans all the way round the court (about 2,800 on Low), drawn in one instanced call. Each fan is a photographed card with a seated and a cheering frame. The crowd rises on threes, roars on your baskets, sits down after misses and goes quiet when the CPU scores.
- **Players**: six fictional players.
  - Yellow: Morrow (#7), Lindqvist (#21), Kasumba (#23).
  - Black: Varga (#3), Arata (#11), Aneke (#34).
  - Each body is a textured, rigged 3D model made from a generated full-body photo, with cloth sway on the jersey hem and shorts.
  - All six players have their own body, in their own Livewire kit and number.
  - Every body rests its arms at the same angle as the rig the motion clips were captured on, so the clips play the same on each of them.
  - With six bodies on court, phones use the lighter (about 30,000-triangle) bodies with 1024 colour maps. High quality uses the full (about 100,000-triangle) ones. The lighter bodies of the four newer players are cut down from their full ones.
  - A body off screen isn't drawn.
- **Motion**: running, walking, backpedalling, defensive slides, stances and jumps come from motion-capture clips, blended by speed and direction. A procedural rig handles dribbling, shooting, passing, catching, layups, dunks, steals and arm IK. A pass is arms only, so the legs keep running under it.
- **Victory dance**: at the final buzzer the winners walk to centre court and dance (three different motion-capture dances) while the losers walk off. The final card sits at the bottom (on the right of a wide screen) and a long-lens camera frames the dancers in the space above it.
- **Replays**: your threes and dunks get a slow-motion replay at basket A, recorded as a shareable clip (`js/replay.js`).
- **Branding**: Livewire (livewire.group) yellow `#CBFE00` and black, its wordmark and its mark, as in the 1v1.
- **Audio** (`sfx/`): the recorded crowd, rim and ball sounds of the 1v1. Ball, rim and sneaker sounds are quieter at the far end of the floor.

## Controls

On phones the game plays in portrait only.

| Action | Touch | Keyboard |
| --- | --- | --- |
| Move | Drag on the left half; push to the edge to sprint | WASD / arrows, Shift to sprint |
| Shoot / Block / Jump | Big yellow button: hold, then release at the top of the jump | J or Space |
| Pass / Switch (or Call, on your inbound) | PASS button | L |
| Dribble move / Steal | MOVE button | K |
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

**Bench** starts a fresh CPU-vs-CPU game and measures 5 seconds each of:

- the game as is
- no shadows
- hard-edged shadows
- no floor reflection
- the reflection at 60% size
- the players left out of the reflection
- no crowd
- 4 of the 6 bodies hidden, to price what the six bodies cost
- 70% resolution
- the game as is again, to show whether the phone slowed down as it warmed up

Bench runs for about a minute and shows a countdown on its button. Copy is off until it finishes. Leaving Safari or pausing stops it. Each frame waits for the GPU to finish, so each result is the real time to draw a frame (script plus GPU) and isn't capped by the 60 Hz screen. Under 16.7 ms holds 60 fps. The step that saves the most time is what the phone is short of.

## Files

- `js/main.js`: renderer, quality tiers, menus, the camera, the loop, building the six players
- `js/game.js`: the 3v3 simulation: tip-off, possessions, inbounds, passing, the shooting model, moves, steals, blocks, the clocks, the hot hand
- `js/ai.js`: the team AI for both sides
- `js/present.js`: sound, crowd, callouts, rings and the HUD, driven by the game's events
- `js/court.js`: full-court geometry, the two baskets and each team's frame
- `js/player.js`: procedural rig and animation, IK, and retargeting onto the skinned models
- `js/motion.js`: the motion-capture layer (clip blending by speed and direction, jump time-warping, the victory dances)
- `js/ball.js`: ball physics at both baskets, and the net cloth
- `js/arena.js`: court, markings, reflections, LED boards, both hoops, the light that follows the play
- `js/crowd.js`: the seating bowl and the animated crowd
- `js/look.js`: arena lighting from the 360° photo, and the colour grade
- `js/replay.js`: highlight recording, replay cameras, and the shareable video clip
- `js/progress.js`: download progress for the Start button
- `js/debug.js`: the `?debug` performance panel
- `js/lwmark.js`: the animated Livewire mark beside the wordmark
- `js/audio.js`: sound playback (recorded crowd and ball sounds, synthesised fallbacks)
- `js/input.js`, `js/data.js`

For testing, `#autoplay` in the address hands both teams to the AI.

## Art and sound

The images and models were generated with Higgsfield: the hardwood texture, team logos, player portraits, and the player models (full-body reference, then image-to-3D with auto-rigging). The motion clips come from the Higgsfield (Meshy) animation library. They were baked to per-bone rotation deltas by `raw/hardwood/anim/convert_clips.py`, which is kept outside the repo. All teams and players are fictional.

The title image (`img/cover.webp`), a dunk seen from behind so no face shows, was supplied by the project owner. The title text baked into it was removed with OpenCV inpainting, so the page's own title sits on top. The arena panorama and the fans were generated with Higgsfield. So was the loading-screen ball: a still made with GPT Image 2.5 (with Livewire's wordmark as the reference), turned into a 360° spin with MiniMax H3 (same first and last frame), then re-timed to an even speed with motion interpolation so it loops without a pause. The fan sheets were cut out and packed by `raw/hardwood/gfx/fans_atlas.py`, and the panorama was reprojected by `raw/hardwood/gfx/pano2equirect.py` (both kept outside the repo).

The crowd and rim sounds are real recordings from Freesound, all CC0 (public domain): FC St. Pauli stadium crowd reactions (itmightgetloud, #829453), a roaring crowd (benfree, #130568), fans at a basketball game (phillyfan972, #412160), Rogers Arena game atmosphere (SEF7, #706497), basketball shots in a gym (kyles, #450722), a steel basketball hoop being struck (jimmyfisher, #402662) and missed shots off a gym rim (amsaenz03, #788261). The swish, backboard, dribble and dunk were generated with ElevenLabs.
