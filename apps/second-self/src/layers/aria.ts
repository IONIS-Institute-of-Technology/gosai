/**
 * Aria: a VRM avatar puppeted by the user's pose, hands and face.
 *
 * It reads the raw `pose.raw_data` landmarks (camera pixel space, unflipped,
 * unsmoothed), not the mirror projection, which is flipped and letterboxed and
 * would corrupt the Kalidokit solves. Kalidokit turns the landmarks into bone
 * rotations and face blendshapes, applied to a VRM model rendered with
 * three.js and @pixiv/three-vrm.
 *
 * Convention note: Kalidokit emits rotations for VRM0 rigs. three-vrm's
 * normalized bones only bake out rest rotations, so their frames stay aligned
 * with the model's glTF world axes, and this VRoid VRM0 model has identity
 * rest rotations on all humanoid bones. Kalidokit rotations therefore apply
 * unchanged (the VRM1 x/z sign flip is only for VRM1-authored models).
 *
 * The WebGL renderer draws into its own canvas, stacked in the compositor's
 * container right below the transparent 2D canvas and aligned with the
 * reference space, so the menu, the overlays and the sleep veil stay on top.
 * Copying WebGL frames into the 2D canvas instead would read pixels back
 * every frame wherever Chromium runs 2D canvases in software. The renderer
 * exists only while the layer runs.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import * as Kalidokit from 'kalidokit';

import type { LayerDeps } from '../shared/deps.js';
import { drawText } from '../shared/draw.js';
import { DEFAULT_FRAME_HEIGHT, DEFAULT_FRAME_WIDTH } from '../shared/feed.js';
import {
  REF_HEIGHT,
  REF_WIDTH,
  type Landmark,
  type Layer,
  type Viewport,
} from '../shared/types.js';

interface Rotation {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationOrder?: THREE.EulerOrder;
}

type HandSide = 'left' | 'right';
type HandBones = ReadonlyArray<readonly [Kalidokit.HandKeys<Kalidokit.Side>, VRMHumanBoneName]>;

const MODEL_PATH = 'aria/models/papa_de_him_chan.vrm';
/** Feed considered stale after this long without a pose update. */
const STALE_MS = 1000;
/** Lerp used to ease bones back to the rest pose when tracking is lost. */
const REST_LERP = 0.08;

const ZERO: Rotation = { x: 0, y: 0, z: 0 };
const LEFT_ARM_DOWN: Rotation = { x: 0, y: 0, z: 1.4 };
const RIGHT_ARM_DOWN: Rotation = { x: 0, y: 0, z: -1.4 };

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
const PARTS = ['Proximal', 'Intermediate', 'Distal'] as const;

/** Kalidokit hand keys and the VRM bones they drive, for one side. */
function handBones(side: HandSide): HandBones {
  const Side = side === 'left' ? 'Left' : 'Right';
  const bones: Array<readonly [Kalidokit.HandKeys<Kalidokit.Side>, VRMHumanBoneName]> = [];
  for (const finger of FINGERS) {
    for (const part of PARTS) bones.push([`${Side}${finger}${part}`, `${side}${finger}${part}`]);
  }
  // Kalidokit's thumb Proximal/Intermediate/Distal map to VRM1 Metacarpal/Proximal/Distal.
  bones.push([`${Side}ThumbProximal`, `${side}ThumbMetacarpal`]);
  bones.push([`${Side}ThumbIntermediate`, `${side}ThumbProximal`]);
  bones.push([`${Side}ThumbDistal`, `${side}ThumbDistal`]);
  return bones;
}

const HANDS = {
  left: { wrist: 'LeftWrist', hand: 'leftHand', bones: handBones('left') },
  right: { wrist: 'RightWrist', hand: 'rightHand', bones: handBones('right') },
} as const;

export function createAriaLayer(deps: LayerDeps): Layer {
  let vrm: VRM | null = null;
  let loadFailed = false;
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, REF_WIDTH / REF_HEIGHT, 0.1, 10);
  camera.position.set(0, 1.4, 0.7);
  camera.lookAt(0, 1.4, 0);
  const timer = new THREE.Timer();

  // Scratch objects reused by every bone on every frame.
  const euler = new THREE.Euler();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const drawingSize = new THREE.Vector2();
  /** The viewport the canvas was last placed at, to skip unchanged style writes. */
  let placement = '';

  /** Lines the WebGL canvas up with the reference space and sizes its drawing buffer. */
  function place(target: THREE.WebGLRenderer, viewport: Viewport): void {
    const { x, y, width, height } = viewport;
    const key = `${x},${y},${width},${height}`;
    if (key === placement) return;
    placement = key;
    const style = target.domElement.style;
    style.left = `${x}px`;
    style.top = `${y}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
    const dpr = window.devicePixelRatio || 1;
    const bufferWidth = Math.max(1, Math.round(width * dpr));
    const bufferHeight = Math.max(1, Math.round(height * dpr));
    const size = target.getSize(drawingSize);
    if (size.x !== bufferWidth || size.y !== bufferHeight) {
      target.setSize(bufferWidth, bufferHeight, false);
    }
  }
  const look = { pitch: 0, yaw: 0 };

  const face = new LandmarkBuffer();
  const pose2d = new LandmarkBuffer();
  const pose3d = new LandmarkBuffer();
  const leftHand = new LandmarkBuffer();
  const rightHand = new LandmarkBuffer();

  /** Slerps a bone toward a Kalidokit rotation (see the convention note above). */
  function rigRotation(
    name: VRMHumanBoneName,
    rot: Rotation,
    dampener = 1,
    lerpAmount = 0.3,
  ): void {
    const bone = vrm?.humanoid.getNormalizedBoneNode(name);
    if (!bone) return;
    euler.set(rot.x * dampener, rot.y * dampener, rot.z * dampener, rot.rotationOrder ?? 'XYZ');
    quaternion.setFromEuler(euler);
    if (Number.isNaN(quaternion.x + quaternion.y + quaternion.z + quaternion.w)) return;
    bone.quaternion.slerp(quaternion, lerpAmount);
  }

  function rigHipsPosition(x: number, y: number, z: number): void {
    const bone = vrm?.humanoid.getNormalizedBoneNode('hips');
    if (!bone || Number.isNaN(x + y + z)) return;
    bone.position.lerp(position.set(x, y, z), 0.07);
  }

  function rigFace(solved: Kalidokit.TFace): void {
    if (!vrm) return;
    rigRotation('neck', solved.head, 0.7, 0.3);
    const exp = vrm.expressionManager;
    if (!exp) return;

    const blink = Kalidokit.Face.stabilizeBlink(
      { l: clampUnit(1 - solved.eye.l), r: clampUnit(1 - solved.eye.r) },
      solved.head.y,
    );
    exp.setValue('blink', lerp(blink.l, exp.getValue('blink') ?? 0, 0.5));

    const m = solved.mouth.shape;
    exp.setValue('ih', lerp(m.I, exp.getValue('ih') ?? 0, 0.5));
    exp.setValue('aa', lerp(m.A, exp.getValue('aa') ?? 0, 0.5));
    exp.setValue('ee', lerp(m.E, exp.getValue('ee') ?? 0, 0.5));
    exp.setValue('oh', lerp(m.O, exp.getValue('oh') ?? 0, 0.5));
    exp.setValue('ou', lerp(m.U, exp.getValue('ou') ?? 0, 0.5));

    if (vrm.lookAt) {
      look.pitch = lerp(look.pitch, solved.pupil.y, 0.4);
      look.yaw = lerp(look.yaw, solved.pupil.x, 0.4);
      // Applied by vrm.update() at the end of the frame, in degrees.
      vrm.lookAt.yaw = THREE.MathUtils.radToDeg(look.yaw);
      vrm.lookAt.pitch = THREE.MathUtils.radToDeg(look.pitch);
    }
  }

  function applyHand(
    side: HandSide,
    solved: Kalidokit.THand<Kalidokit.Side>,
    wristZ: number,
  ): void {
    const { wrist, hand, bones } = HANDS[side];
    const w = solved[wrist];
    rigRotation(hand, { x: w.x, y: w.y, z: wristZ });
    for (const [key, bone] of bones) rigRotation(bone, solved[key]);
  }

  /** Eases the body back to a relaxed rest pose, arms down. */
  function restBody(lerpAmount = REST_LERP): void {
    rigRotation('hips', ZERO, 1, lerpAmount);
    rigRotation('chest', ZERO, 1, lerpAmount);
    rigRotation('spine', ZERO, 1, lerpAmount);
    rigRotation('neck', ZERO, 1, lerpAmount);
    rigRotation('leftUpperArm', LEFT_ARM_DOWN, 1, lerpAmount);
    rigRotation('leftLowerArm', ZERO, 1, lerpAmount);
    rigRotation('rightUpperArm', RIGHT_ARM_DOWN, 1, lerpAmount);
    rigRotation('rightLowerArm', ZERO, 1, lerpAmount);
    // The hips position stays where it was last seen instead of drifting.
  }

  function restHand(side: HandSide): void {
    const { hand, bones } = HANDS[side];
    rigRotation(hand, ZERO, 1, REST_LERP);
    for (const [, bone] of bones) rigRotation(bone, ZERO, 1, REST_LERP);
  }

  function animate(nowMs: number): void {
    const raw = deps.feed.raw;
    const stale = nowMs - raw.lastUpdate > STALE_MS;
    const d = raw.data;
    const width = d.frame_width || DEFAULT_FRAME_WIDTH;
    const height = d.frame_height || DEFAULT_FRAME_HEIGHT;
    const imageSize = { width, height };

    const faceLm = face.fill(stale ? [] : d.face_mesh, width, height);
    const pose2dLm = pose2d.fill(stale ? [] : d.body_pose, width, height);
    const pose3dLm = pose3d.fill(stale ? [] : d.body_world_pose);
    // Canonical Kalidokit mirror mapping: the solver's "Left" outputs come
    // from the person's anatomical right side and drive the avatar's left
    // bones. The driver's `left_hand_pose` holds the anatomical right hand.
    const leftLm = leftHand.fill(stale ? [] : d.left_hand_pose, width, height);
    const rightLm = rightHand.fill(stale ? [] : d.right_hand_pose, width, height);

    if (faceLm.length > 0) {
      const solved = trySolve(() =>
        Kalidokit.Face.solve(faceLm, { runtime: 'mediapipe', imageSize }),
      );
      if (solved) rigFace(solved);
    }

    let pose: Kalidokit.TPose | undefined;
    if (pose2dLm.length > 0 && pose3dLm.length > 0) {
      pose = trySolve(() =>
        Kalidokit.Pose.solve(pose3dLm, pose2dLm, { runtime: 'mediapipe', imageSize }),
      );
      if (pose) {
        if (pose.Hips.rotation) rigRotation('hips', pose.Hips.rotation, 0.7);
        const nose = pose2dLm[0];
        rigHipsPosition(
          -(nose?.x ?? 0) * 1.8 + 1.2,
          -(nose?.y ?? 0) * 1.8 + 1.8,
          -(nose?.z ?? 0) * 1.5 + 1.5,
        );
        rigRotation('chest', pose.Spine, 0.25, 0.3);
        rigRotation('spine', pose.Spine, 0.45, 0.3);
        // No side crossing: Kalidokit's Left outputs already come from the
        // person's right arm. Crossing them flips the arms upside down.
        rigRotation('leftUpperArm', pose.LeftUpperArm);
        rigRotation('leftLowerArm', pose.LeftLowerArm);
        rigRotation('rightUpperArm', pose.RightUpperArm);
        rigRotation('rightLowerArm', pose.RightLowerArm);
      }
    } else {
      restBody();
    }

    const leftSolved =
      leftLm.length > 0 ? trySolve(() => Kalidokit.Hand.solve(leftLm, 'Left')) : undefined;
    if (leftSolved) applyHand('left', leftSolved, pose?.LeftHand.z ?? 0);
    else if (leftLm.length === 0) restHand('left');
    const rightSolved =
      rightLm.length > 0 ? trySolve(() => Kalidokit.Hand.solve(rightLm, 'Right')) : undefined;
    if (rightSolved) applyHand('right', rightSolved, pose?.RightHand.z ?? 0);
    else if (rightLm.length === 0) restHand('right');
  }

  return {
    async preload(): Promise<void> {
      // Close to the legacy setup (one directional light at intensity 1):
      // MToon materials blow out to white under stronger rigs.
      const key = new THREE.DirectionalLight(0xffffff, 1.0);
      key.position.set(1, 1, 1).normalize();
      scene.add(key);
      // Soft fill so the shaded side reads against the dark compositor.
      const fill = new THREE.DirectionalLight(0xbfd4ff, 0.25);
      fill.position.set(-1, 0.4, 1).normalize();
      scene.add(fill);
      scene.add(new THREE.AmbientLight(0xffffff, 0.3));

      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      await deps.assets.require('aria', [MODEL_PATH]);
      try {
        const gltf = await loader.loadAsync(deps.asset(MODEL_PATH));
        const loaded: VRM | undefined = gltf.userData.vrm;
        if (!loaded) throw new Error('the file holds no VRM');
        loaded.scene.rotation.y = Math.PI;
        loaded.scene.position.set(0, 0, -1);
        scene.add(loaded.scene);
        vrm = loaded;
        restBody(1); // Start relaxed, not in the T-pose.
      } catch (err) {
        deps.rt.log.warn('aria: VRM load failed', { err: String(err) });
        loadFailed = true;
      }
    },

    start(): void {
      if (loadFailed) return;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;display:block;pointer-events:none;';
      const { container, canvas: compositor } = deps.surface;
      container.insertBefore(canvas, compositor);
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(1);
      placement = '';
      timer.reset();
      deps.setFaceMesh('raw', true);
    },

    render({ ctx, timestamp, viewport }): void {
      if (!renderer) {
        drawPlaceholder(ctx);
        return;
      }
      place(renderer, viewport);
      animate(timestamp);
      timer.update(timestamp);
      vrm?.update(timer.getDelta());
      renderer.render(scene, camera);
    },

    suspend(): void {
      if (renderer) renderer.domElement.style.visibility = 'hidden';
    },

    resume(): void {
      if (renderer) renderer.domElement.style.visibility = 'visible';
    },

    stop(): void {
      if (!renderer) return;
      deps.setFaceMesh('raw', false);
      renderer.domElement.remove();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface KLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number | undefined;
}

/** Kalidokit landmark objects for one stream, reused from frame to frame. */
class LandmarkBuffer {
  private readonly items: KLandmark[] = [];
  private readonly view: KLandmark[] = [];

  /**
   * Converts landmark rows. With a frame size, 2D rows are normalised by it
   * and the third value passes through as z and visibility, as the legacy app
   * did; without one, metric world rows `[x, y, z, visibility]` pass through.
   */
  fill(rows: readonly Landmark[], width?: number, height?: number): KLandmark[] {
    this.view.length = 0;
    for (const row of rows) {
      if (row.length < 2) continue;
      const lm = (this.items[this.view.length] ??= { x: 0, y: 0, z: 0, visibility: undefined });
      if (width && height) {
        lm.x = row[0]! / width;
        lm.y = row[1]! / height;
        lm.z = row[2] ?? 0;
        lm.visibility = row[2];
      } else {
        lm.x = row[0]!;
        lm.y = row[1]!;
        lm.z = row[2] ?? 0;
        lm.visibility = row[3];
      }
      this.view.push(lm);
    }
    return this.view;
  }
}

/** Runs a Kalidokit solve, tolerating internal errors (e.g. missing iris points). */
function trySolve<T>(solve: () => T | undefined): T | undefined {
  try {
    return solve();
  } catch {
    return undefined;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clampUnit(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function drawPlaceholder(ctx: CanvasRenderingContext2D): void {
  const x = REF_WIDTH / 2;
  // Above centre: a broken-asset card from the guide overlay sits in the
  // middle of the screen and would land right on top of this.
  const y = REF_HEIGHT / 4;
  drawText(ctx, 'Aria', x, y - 30, 64, 'rgba(255,255,255,0.85)', 'center', 'middle');
  drawText(
    ctx,
    'VRM avatar model could not be loaded',
    x,
    y + 40,
    28,
    'rgba(255,255,255,0.5)',
    'center',
    'middle',
  );
}
