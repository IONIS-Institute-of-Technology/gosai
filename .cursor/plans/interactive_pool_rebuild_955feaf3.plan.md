---
name: Interactive Pool Rebuild
overview: Rebuild the interactive-pool application as a clean gosai-2 app at apps/interactive-pool/, reimplementing all features (balls, cue, hands, menu, rabbits, affine, triangles, univers, ambient, live) using the gosai-2 SDK with TypeScript and Canvas2D rendering.
todos:
  - id: phase-1
    content: "Phase 1: App scaffold, manifest, build system, shared types and canvas utilities"
    status: completed
  - id: phase-2
    content: "Phase 2: Ball overlay and cue line rendering with driver subscriptions"
    status: completed
  - id: phase-3
    content: "Phase 3: Hand skeleton overlay (21 landmarks, joint connections)"
    status: completed
  - id: phase-4
    content: "Phase 4: Gesture-based menu system (two-hand trigger, animated open/close, app navigation, graceful audio)"
    status: completed
  - id: phase-5
    content: "Phase 5: Rabbits game (moving characters, ball collision, firework particles, respawn)"
    status: completed
  - id: phase-6
    content: "Phase 6: Affine function visualization (coordinate grid, line computation, equation display)"
    status: completed
  - id: phase-7
    content: "Phase 7: Triangle geometry (angles, medians, perpendicular bisectors, circumscribed circle)"
    status: completed
  - id: phase-8
    content: "Phase 8: Univers experience (starfield, per-ball solar systems with orbiting planets)"
    status: completed
  - id: phase-9
    content: "Phase 9: Ambient display experience (drifting dots, sensor-driven fireworks)"
    status: completed
  - id: phase-10
    content: "Phase 10: Main orchestrator experience (layer compositor, z-ordering, full integration)"
    status: completed
  - id: phase-11
    content: "Phase 11: Live streaming experience (relay ball data to external server)"
    status: completed
  - id: phase-12
    content: "Phase 12: Build verification, type checking, error handling, polish"
    status: completed
isProject: false
---

# Interactive Pool Rebuild for GOSAI-2

## What We Are Building

The interactive-pool project is an augmented reality system that projects interactive visuals onto a pool/billiard table. A camera detects balls, hands, and cues on the table, and a projector overlays graphics in real-time. The legacy system uses p5.js sketches with Socket.IO and Python backends. We will rewrite it as a single gosai-2 app at `apps/interactive-pool/` using the `@gosai/sdk` TypeScript SDK with Canvas2D rendering and the new driver subscription system.

## Legacy Feature Inventory

The legacy codebase has 14 "apps". Based on scope decisions, we are porting the following as **layers/experiences** within a single gosai-2 app:

**Always-on overlays (render every frame):**
1. **balls** - Renders detected ball positions as white circle outlines on the table
2. **cue** - Renders the detected cue stick as a line between two points
3. **show_hands** - Renders hand skeletons (21 landmarks per hand with joints/connections)

**Menu system (always active):**
4. **menu** - Gesture-activated menu (two-finger pinch-to-open/close), app navigation, fill-progress activation, auto-close timers. Audio feedback via optional sound files (graceful fallback if files not found).

**Launchable experiences (one at a time via menu):**
5. **rabbits_game** - Moving rabbit characters killed by ball collisions, firework particles, respawn
6. **affine** - Affine function visualization from ball positions (y = ax + b)
7. **triangles_remarkable_lines** - Triangle geometry explorer (angles, medians, perpendicular bisectors, circumscribed circle)
8. **univers** - Galaxy starfield + per-ball solar systems with orbiting planets
9. **ambient_display** - Drifting dots with sensor-driven firework bursts

**Background/utility:**
10. **live** - Streams normalized ball positions to a configurable external server

**Skipped (by decision):**
- `triangles_full_lesson` / `triangles_short_lesson` - Complex state-machine lessons requiring 40+ French audio files not in git
- `control_password` - Simple password display (trivial, not useful for new system)

### Driver Dependencies
- `ball` driver: emits `balls` (array of [x,y] positions) and `fps`
- `cue` driver: emits `cue` (boolean + two [x,y] endpoints)
- `hand_pose` driver: emits `raw_data` (landmarks per hand in normalized 0..1 coords)
- `hand_sign` driver: emits `sign` (gesture classification)
- `sensor_server` driver: emits `movements` (distance readings from external sensors) -- used by ambient_display only

## Architecture for the New App

### Directory Structure

```
apps/interactive-pool/
  gosai.app.json          # App manifest with all experiences
  package.json            # Dependencies: @gosai/sdk
  tsconfig.json           # TypeScript config
  assets/
    audio/                # User-provided audio files (opening_menu.mp3, etc.)
  src/
    shared/
      types.ts            # Shared types (Ball, Hand, CueData, etc.)
      canvas-utils.ts     # Fullscreen canvas setup, coordinate helpers
      math.ts             # Vector math, intersection, distance helpers
      audio.ts            # Graceful audio loading/playback helper
    layers/
      balls.ts            # Ball detection overlay layer
      cue.ts              # Cue line overlay layer
      show-hands.ts       # Hand skeleton overlay layer
      menu.ts             # Gesture-based menu layer
      rabbits-game.ts     # Rabbits game layer
      affine.ts           # Affine function visualization layer
      triangles.ts        # Triangle remarkable lines layer
      univers.ts          # Galaxy + solar systems layer
      ambient-display.ts  # Drifting dots + sensor fireworks layer
      live.ts             # External streaming (headless)
    main.ts               # Default experience entry (orchestrator/compositor)
  dist/                   # Built output
```

Note: we use "layers" instead of "experiences" for the sub-modules because they are composited within a single gosai-2 experience (`main`), not standalone experiences. The gosai-2 experience system runs one experience at a time per app-host window, so all visual layers must be managed within the main experience's render loop.

### Experience Design

Each legacy "app" becomes an **experience** in the gosai-2 sense. However, in the legacy system, multiple sketches ran concurrently (balls + show_hands + menu were all active simultaneously). In gosai-2, we need to handle this within a single experience, since only one experience runs at a time in the app-host window.

**Solution: The `main` experience is always the active one.** It acts as a compositor/orchestrator that:
- Always renders the ball overlay and hand overlay (these are always-on layers)
- Manages the gesture menu system (always listening for hand gestures)
- Launches "sub-layers" (rabbits, affine, triangles, univers, ambient) as additional render layers within the same experience

This matches the legacy behavior where `balls`, `show_hands`, and `menu` were "startup" apps that always ran, and the menu launched additional experiences on top.

Alternatively, each experience can be fully standalone (including its own ball/hand rendering), and the menu experience uses `rt.router.switchTo()` to navigate between them. This is cleaner for the gosai-2 architecture.

**Chosen approach: Composite main experience** that manages layers, since the legacy system required simultaneous rendering of balls + hands + menu + active game. Each "layer" is a module with its own `start`/`render`/`stop` lifecycle.

### Key SDK APIs Used

From the calibration app example and SDK source:

- `defineExperience<State>({ slug, name, init, start, render, stop })` - experience definition
- `rt.drivers.on('ball', 'balls', callback)` - subscribe to ball positions
- `rt.drivers.on('hand_pose', 'raw_data', callback)` - subscribe to hand data
- `rt.drivers.on('cue', 'cue', callback)` - subscribe to cue detection
- `rt.events.emit(topic, data)` / `rt.events.on(topic, callback)` - cross-window events
- `rt.storage.get/set` - persist settings
- `rt.router.switchTo(slug)` - switch experiences
- `rt.log.info/warn/error` - structured logging
- `createCanvas()` / `fullscreenContainer()` / `fitCanvas()` - rendering helpers

### Rendering Approach

Replace p5.js with native Canvas2D API. All legacy p5.js calls (circle, line, rect, text, push/pop, translate, rotate, fill, stroke) have direct Canvas2D equivalents. This eliminates the p5.js dependency entirely.

## Implementation Phases

### Phase 1: App Scaffold and Shared Utilities

**What to achieve:** Create the app directory from scratch (based on the calibration app template), set up the manifest, build system, shared types, and Canvas2D utility helpers.

**Detailed instructions for agent:**
- Copy the structure from `apps/calibration/` (package.json, tsconfig.json, gosai.app.json) as a starting template
- Create `apps/interactive-pool/gosai.app.json` with all experiences listed, drivers: `["ball", "hand_pose", "hand_sign", "cue"]`
- Create shared types in `src/shared/types.ts`: `Ball {x,y,r}`, `HandLandmark`, `CueData`, `MenuState`, etc.
- Create `src/shared/canvas-utils.ts`: fullscreen setup, DPR-aware canvas sizing, draw helpers (circle, line, polygon, text with rotation)
- Create `src/shared/math.ts`: distance, vector math, line intersection, angle calculation (porting from legacy Triangle class)
- Wire the bun build command: `bun build src/main.ts --target=browser --format=esm --outdir dist --external @gosai/sdk`

### Phase 2: Ball Overlay and Cue Line Rendering

**What to achieve:** Implement the two simplest rendering layers (ball circles and cue line) as a baseline that proves the driver subscription and render loop work.

**Detailed instructions for agent:**
- Create `src/experiences/balls.ts`: subscribes to `rt.drivers.on('ball', 'balls', ...)`, receives array of `[x,y]` positions, renders white circle outlines (stroke, no fill, strokeWeight 8, radius 80) at each position. Pool pre-allocates 20 ball slots, moves unused ones offscreen at (-500,-500). Also displays FPS counter text.
- Create `src/experiences/cue.ts`: subscribes to `rt.drivers.on('cue', 'cue', ...)`, receives `[detected:boolean, [x1,y1], [x2,y2]]`, renders a white line (strokeWeight 10) between the two endpoints when detected is true.
- Both modules export `{ init, start, render, stop }` functions that take a canvas context and driver subscriptions as state.

### Phase 3: Hand Skeleton Overlay

**What to achieve:** Render hand landmarks and connections as an overlay, matching the legacy show_hands behavior.

**Detailed instructions for agent:**
- Create `src/experiences/show-hands.ts`: subscribes to `rt.drivers.on('hand_pose', 'raw_data', ...)`, receives `{ hands_landmarks: number[][][] }` (array of hands, each hand is 21 landmarks of [x,y] in 0..1 normalized coordinates).
- Render each hand: magenta filled circles at each landmark (scaled to canvas width/height), magenta lines connecting joints according to the hand_junctions map (palm: 0-1, 0-5, 0-9, 0-13, 0-17, 5-9, 9-13, 13-17; thumb: 1-2, 2-3, 3-4; index: 5-6, 6-7, 7-8; middle: 9-10, 10-11, 11-12; ring: 13-14, 14-15, 15-16; pinky: 17-18, 18-19, 19-20).
- strokeWeight 4 for connections, circle size 10 for landmarks.

### Phase 4: Gesture-Based Menu System

**What to achieve:** Implement the full gesture-activated menu that lets users browse and launch experiences. This is the most complex piece.

**Detailed instructions for agent:**
- Create `src/experiences/menu.ts` implementing:
  - **Menu trigger detection**: Two hands detected, track index finger tips (landmark 8) for each hand. When both index fingers are close together (gap_x < 90, gap_y < 100), start trigger. When fingers spread apart (gap_x 250-500, y stable within 70px), open menu with animation. Reverse gesture closes menu.
  - **Menu rendering**: Animated open/close (percentage-based width/height scaling from 0-100%). When open: display "- MENU -" title, current app name, left/right arrow navigation buttons, app activation button.
  - **Button interaction**: Track index finger position against button bounds. Fill progress bar when finger hovers over button. When progress bar fills completely, trigger the action (navigate or launch/stop app). Include cooldown system to prevent rapid re-triggering.
  - **App lifecycle**: Use `rt.router.switchTo(slug)` for experience switching, or manage layers internally via events.
  - **Auto-close timer**: 10 seconds of no hand detection closes the menu. 60 seconds of no hand detection stops launched educational apps.
  - **Audio feedback**: Load audio files from `assets/audio/` relative paths (opening_menu.mp3, closing_menu.mp3, click.mp3). Use a helper that attempts to load and play; if the file fails to load (404 or decode error), silently skip. Never crash or log errors for missing audio -- just degrade gracefully. The user will manually add the files later.
- **Menu-controlled experiences list**: `["rabbits_game", "affine", "triangles", "univers", "ambient_display"]` -- these are the apps the menu can start/stop.

### Phase 5: Rabbits Game

**What to achieve:** Implement the full rabbits game where rabbit characters move across the screen and are "killed" by detected balls.

**Detailed instructions for agent:**
- Create `src/experiences/rabbits-game.ts`:
  - Spawn 6 rabbit characters at random Y positions on the left edge
  - Each rabbit moves rightward at speed 2-2.5 with random vertical drift, bouncing off top/bottom edges, wrapping horizontally
  - Rabbit rendering: entirely procedural (Canvas2D shapes): green body circle, ears (rotated ellipses), eyes, nose, teeth, whiskers, smile - all drawn with canvas path operations. Port exactly from the legacy `rabbit.js` draw code.
  - Collision detection: when a detected ball position overlaps a rabbit (distance < sum of radii/2), the rabbit "dies"
  - Death effect: firework particle explosion (100 particles with random velocities, colors, and fade-out), ghost rabbit (gray, fading alpha). After 3 seconds dead, respawn at left edge.
  - Subscribes to ball driver for ball positions
  - This is an exclusive experience: when active, other educational experiences should stop

### Phase 6: Affine Function Visualization

**What to achieve:** Implement the educational experience that computes and displays affine functions from ball positions.

**Detailed instructions for agent:**
- Create `src/experiences/affine.ts`:
  - Uses ball positions (first 2 detected balls) as points on a coordinate plane
  - Converts screen coordinates to grid coordinates: grid is 22x12 centered on screen (960,540 is origin)
  - Computes slope `a = (y2-y1)/(x2-x1)` and intercept `b = y1 - a*x1`
  - Draws the affine line extending to screen edges (clipped to grid bounds)
  - Displays the equation `y = ax + b` near the line with proper formatting (handles special cases: a=0, a=1, a=-1, b=0, b positive/negative)
  - Optionally draws the coordinate grid with axes, arrows, graduations, and labels
  - Port the coordinate conversion functions exactly from legacy `affine.js`

### Phase 7: Triangle Geometry Visualization

**What to achieve:** Implement the triangle geometry experience showing remarkable lines and properties.

**Detailed instructions for agent:**
- Create `src/experiences/triangles.ts`:
  - Uses first 3 detected balls as triangle vertices A, B, C
  - Draws the triangle (white lines, strokeWeight 5)
  - Computes and displays:
    - All three angles (using law of cosines)
    - Centroid (average of vertices) with yellow dot
    - Medians (lines from each vertex to opposite midpoint) in yellow
    - Perpendicular bisectors of each side in magenta
    - Circumcenter (intersection of perpendicular bisectors) with magenta dot
    - Circumscribed circle through all three vertices in magenta
  - Right triangle detection: changes color to blue `[0,170,255]` when any angle is 90 degrees
  - Angle labels displayed near each vertex, rotated 180 degrees (for projector orientation)
  - Port ALL math from legacy `triangle.js` class

### Phase 8: Univers Experience (Galaxy + Solar Systems)

**What to achieve:** Implement the universe visualization where each detected ball spawns a solar system with orbiting planets, set against a galaxy starfield.

**Detailed instructions for agent:**
- Create `src/experiences/univers.ts`:
  - **Galaxy background**: 4000 rotating star particles (from legacy Galaxy class). Stars have random positions within an elliptical region, random brightness, rotate slowly around center.
  - **Starfield background**: Additional white dots (WhiteDot class) that twinkle/drift slowly across the screen.
  - **Per-ball solar systems**: For each detected ball (up to 6), render a SolarSystem at the ball position:
    - Sun: colored circle at ball center (randomized warm colors)
    - 8 orbiting planets at different radii and speeds
    - Each planet has random size, color, orbit radius, orbit speed
    - Some planets have rings (thin ellipses at orbit angle)
    - Planets orbit the sun using trigonometric positioning (angle += speed per frame)
  - Port the rendering logic from legacy `univers/components/` files (Galaxy.js, SolarSystem.js, planet.js, WhiteDot.js, Ball.js, Bubble.js, starGalax.js)
  - This is an exclusive experience (stops other game/edu experiences)

### Phase 9: Ambient Display Experience

**What to achieve:** Implement the ambient display that shows drifting dots and triggers firework bursts from sensor data.

**Detailed instructions for agent:**
- Create `src/experiences/ambient-display.ts`:
  - **Drifting dots**: 50 dots with random positions, slow random drift velocities, fading in/out
  - **Sensor-driven fireworks**: subscribes to `rt.drivers.on('sensor_server', 'movements', ...)`. When any sensor distance drops below threshold (< 50), trigger a firework burst at a mapped position
  - **Firework system**: Reuse the same particle system from rabbits game (100 particles, random velocities/colors, alpha decay, velocity dampening)
  - Port from legacy `ambient_display/components/` (dot.js, fireworks.js, part.js)
  - This is an exclusive experience
  - Note: if `sensor_server` driver is not available, the experience still works as a passive dot drift visualization (graceful degradation)

### Phase 10: Main Orchestrator Experience and Integration

**What to achieve:** Wire everything together into the main entry point that composites all layers and manages the full experience lifecycle.

**Detailed instructions for agent:**
- Create `src/main.ts` as the default experience entry point using `defineExperience`
- The main experience acts as a **layer compositor**: it maintains a stack of active "layers" (balls, cue, show_hands, menu, and optionally one of: rabbits/affine/triangles/univers/ambient)
- Always-on layers: balls overlay, hand skeleton overlay, menu system
- When menu launches an app (rabbits, affine, triangles, univers, ambient): that layer becomes active and renders on top. Only one "game" layer active at a time.
- Use a single Canvas2D context with proper clear/draw ordering per frame
- The render loop calls each active layer's render function in z-order: background (black) -> active game/edu layer -> balls overlay -> cue overlay -> hands overlay -> menu overlay
- Handle lifecycle: subscribe to all required drivers on start, clean up on stop
- Register all experiences in `gosai.app.json` with the main entry as default
- Display title "Interactive Pool Project" and FPS counter at bottom of screen (legacy behavior)

### Phase 11: Live Streaming Experience

**What to achieve:** Port the live streaming feature that sends ball data to an external server.

**Detailed instructions for agent:**
- Create `src/experiences/live.ts`: receives ball positions, normalizes them to 0..1 (divide by 1920/1080), and sends them via WebSocket to an external endpoint (configurable URL stored in `rt.storage` under key `live_server_url`)
- This is a headless experience (no visual rendering) - it just relays data
- Default URL: empty (disabled). User configures via storage.
- Graceful handling: if WebSocket fails to connect, log a warning and retry periodically. Never crash.

### Phase 12: Build Verification and Polish

**What to achieve:** Ensure the app builds, all TypeScript compiles cleanly, the manifest is correct, and the code is production-ready.

**Detailed instructions for agent:**
- Run `bun run build` in `apps/interactive-pool` and fix any errors
- Run `tsc --noEmit` and fix all type errors
- Verify the `gosai.app.json` manifest is valid and lists all experiences with correct entry paths and driver lists
- Ensure all driver subscriptions are properly cleaned up in stop() handlers (no leaked listeners)
- Add proper error handling for missing drivers (graceful degradation if ball/hand/cue/sensor_server drivers aren't running)
- Verify the render loop handles missing data gracefully (no crashes if no balls/hands detected)
- Clean up any debug code, ensure consistent code style
- Verify the `assets/audio/` directory exists (empty, for user to add sound files later)
