/**
 * Aria: a VRM avatar puppeted by the user's pose, hands and face.
 *
 * Ports the legacy `aria` app. Like the legacy version it consumes the **raw**
 * `pose.raw_data` landmarks (camera pixel space, unflipped, unsmoothed) — not
 * the mirror projection, which is flipped/letterboxed and would corrupt the
 * Kalidokit solves. Landmarks are solved into humanoid bone rotations and face
 * blendshapes with Kalidokit, then applied to a VRM model rendered with
 * three.js + @pixiv/three-vrm (v3).
 *
 * Convention note: Kalidokit emits rotations for VRM0 rigs (legacy three-vrm
 * 0.x raw bones). three-vrm v3 *normalized* bones only bake out rest
 * rotations — their frames stay aligned with the model's glTF world axes —
 * and this VRoid VRM0 model has identity rest rotations on all humanoid
 * bones, so Kalidokit rotations apply unchanged (no VRM1 x/z sign flip; that
 * conversion is only for VRM1-authored models, whose bone frames are yawed
 * 180 deg).
 *
 * Unlike the 2D layers this owns its own transparent WebGL canvas overlaid on
 * the compositor; it does not draw into the shared 2D context.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, type VRMHumanBoneName } from '@pixiv/three-vrm';
import * as Kalidokit from 'kalidokit';

import { drawText } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import {
  REF_HEIGHT,
  REF_WIDTH,
  type FrameContext,
  type Landmark,
  type Layer,
} from '../shared/types.js';

type Vec3 = { x: number; y: number; z: number };
type Euler = { x: number; y: number; z: number; rotationOrder?: string };

/** Feed considered stale after this long without a pose update. */
const STALE_MS = 1000;
/** Lerp used to ease bones back to the rest pose when tracking is lost. */
const REST_LERP = 0.08;

/** Kalidokit finger key -> VRM1 bone name, per hand side. */
const FINGER_BONES = ['Index', 'Middle', 'Ring', 'Little'] as const;
const FINGER_PARTS = ['Proximal', 'Intermediate', 'Distal'] as const;

const RAD2DEG = 180 / Math.PI;

export function createAriaLayer(deps: LayerDeps): Layer {
  let renderer: THREE.WebGLRenderer | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let vrm: VRM | null = null;
  let loadFailed = false;
  const clock = new THREE.Clock();
  const oldLookTarget = new THREE.Euler();

  const resize = (): void => {
    if (!renderer || !camera) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  /** Slerp a bone toward a Kalidokit rotation (see convention note above). */
  function rigRotation(name: VRMHumanBoneName, rot: Euler, dampener = 1, lerpAmount = 0.3): void {
    const bone = vrm?.humanoid.getNormalizedBoneNode(name);
    if (!bone) return;
    const euler = new THREE.Euler(
      rot.x * dampener,
      rot.y * dampener,
      rot.z * dampener,
      (rot.rotationOrder as THREE.EulerOrder) || 'XYZ',
    );
    const q = new THREE.Quaternion().setFromEuler(euler);
    if ([q.x, q.y, q.z, q.w].some((v) => Number.isNaN(v))) return;
    bone.quaternion.slerp(q, lerpAmount);
  }

  function rigPosition(name: VRMHumanBoneName, pos: Vec3, dampener = 1, lerpAmount = 0.3): void {
    const bone = vrm?.humanoid.getNormalizedBoneNode(name);
    if (!bone) return;
    const target = new THREE.Vector3(pos.x * dampener, pos.y * dampener, pos.z * dampener);
    if ([target.x, target.y, target.z].some((v) => Number.isNaN(v))) return;
    bone.position.lerp(target, lerpAmount);
  }

  function rigFace(face: Kalidokit.TFace): void {
    if (!vrm) return;
    rigRotation('neck', face.head as Euler, 0.7, 0.3);
    const exp = vrm.expressionManager;
    if (!exp) return;

    const blink = Kalidokit.Face.stabilizeBlink(
      { l: clampUnit(1 - face.eye.l), r: clampUnit(1 - face.eye.r) },
      face.head.y,
    );
    exp.setValue('blink', lerp(blink.l, exp.getValue('blink') ?? 0, 0.5));

    const m = face.mouth.shape;
    exp.setValue('ih', lerp(m.I, exp.getValue('ih') ?? 0, 0.5));
    exp.setValue('aa', lerp(m.A, exp.getValue('aa') ?? 0, 0.5));
    exp.setValue('ee', lerp(m.E, exp.getValue('ee') ?? 0, 0.5));
    exp.setValue('oh', lerp(m.O, exp.getValue('oh') ?? 0, 0.5));
    exp.setValue('ou', lerp(m.U, exp.getValue('ou') ?? 0, 0.5));

    if (vrm.lookAt) {
      const lookTarget = new THREE.Euler(
        lerp(oldLookTarget.x, face.pupil.y, 0.4),
        lerp(oldLookTarget.y, face.pupil.x, 0.4),
        0,
        'XYZ',
      );
      oldLookTarget.copy(lookTarget);
      // Applied by vrm.update() at the end of the frame (degrees).
      vrm.lookAt.yaw = lookTarget.y * RAD2DEG;
      vrm.lookAt.pitch = lookTarget.x * RAD2DEG;
    }
  }

  function applyHand(
    side: 'left' | 'right',
    rigged: Record<string, Euler>,
    poseWristZ: number,
  ): void {
    const Side = side === 'left' ? 'Left' : 'Right';
    const wrist = rigged[`${Side}Wrist`];
    if (wrist)
      rigRotation(`${side}Hand` as VRMHumanBoneName, { x: wrist.x, y: wrist.y, z: poseWristZ });
    for (const finger of FINGER_BONES) {
      for (const part of FINGER_PARTS) {
        const k = rigged[`${Side}${finger}${part}`];
        if (k) rigRotation(`${side}${finger}${part}` as VRMHumanBoneName, k);
      }
    }
    // Thumb: Kalidokit Proximal/Intermediate/Distal -> VRM1 Metacarpal/Proximal/Distal.
    const thumbMap: Array<[string, string]> = [
      [`${Side}ThumbProximal`, `${side}ThumbMetacarpal`],
      [`${Side}ThumbIntermediate`, `${side}ThumbProximal`],
      [`${Side}ThumbDistal`, `${side}ThumbDistal`],
    ];
    for (const [src, dst] of thumbMap) {
      const k = rigged[src];
      if (k) rigRotation(dst as VRMHumanBoneName, k);
    }
  }

  /** Ease the body (hips/spine/arms) back to a relaxed rest pose. */
  function restBody(lerpAmount = REST_LERP): void {
    const zero: Euler = { x: 0, y: 0, z: 0 };
    rigRotation('hips', zero, 1, lerpAmount);
    rigRotation('chest', zero, 1, lerpAmount);
    rigRotation('spine', zero, 1, lerpAmount);
    rigRotation('neck', zero, 1, lerpAmount);
    // Arms down (legacy load pose; values in the Kalidokit/VRM0 frame).
    rigRotation('leftUpperArm', { x: 0, y: 0, z: 1.4 }, 1, lerpAmount);
    rigRotation('leftLowerArm', zero, 1, lerpAmount);
    rigRotation('rightUpperArm', { x: 0, y: 0, z: -1.4 }, 1, lerpAmount);
    rigRotation('rightLowerArm', zero, 1, lerpAmount);
    // Hips position is left untouched: the model stays where it was last seen
    // instead of drifting to an arbitrary anchor.
  }

  /** Ease one hand (wrist + fingers) back to a neutral pose. */
  function restHand(side: 'left' | 'right', lerpAmount = REST_LERP): void {
    const zero: Euler = { x: 0, y: 0, z: 0 };
    rigRotation(`${side}Hand` as VRMHumanBoneName, zero, 1, lerpAmount);
    for (const finger of FINGER_BONES) {
      for (const part of FINGER_PARTS) {
        rigRotation(`${side}${finger}${part}` as VRMHumanBoneName, zero, 1, lerpAmount);
      }
    }
    rigRotation(`${side}ThumbMetacarpal` as VRMHumanBoneName, zero, 1, lerpAmount);
    rigRotation(`${side}ThumbProximal` as VRMHumanBoneName, zero, 1, lerpAmount);
    rigRotation(`${side}ThumbDistal` as VRMHumanBoneName, zero, 1, lerpAmount);
  }

  function animate(nowMs: number): void {
    if (!vrm) return;
    const raw = deps.feed.raw;
    const stale = nowMs - raw.lastUpdate > STALE_MS;
    const d = raw.data;

    const imageSize = {
      width: d.frame_width || 1280,
      height: d.frame_height || 720,
    };

    const face = stale ? [] : toLandmarks(d.face_mesh, false, imageSize);
    const pose2d = stale ? [] : toLandmarks(d.body_pose, false, imageSize);
    const pose3d = stale ? [] : toLandmarks(d.body_world_pose, true, imageSize);
    // Canonical Kalidokit mirror mapping: the solver's "Left" outputs are
    // calibrated from the person's anatomical RIGHT side and drive the
    // avatar's left bones. The driver's `left_hand_pose` holds the anatomical
    // right hand (legacy swapped convention), i.e. exactly the "Left" input.
    const leftHand = stale ? [] : toLandmarks(d.left_hand_pose, false, imageSize);
    const rightHand = stale ? [] : toLandmarks(d.right_hand_pose, false, imageSize);

    if (face.length > 0) {
      const riggedFace = trySolve(() =>
        Kalidokit.Face.solve(face, { runtime: 'mediapipe', imageSize }),
      );
      if (riggedFace) rigFace(riggedFace);
    }

    let riggedPose: Kalidokit.TPose | undefined;
    if (pose2d.length > 0 && pose3d.length > 0) {
      riggedPose =
        trySolve(() => Kalidokit.Pose.solve(pose3d, pose2d, { runtime: 'mediapipe', imageSize })) ??
        undefined;
      if (riggedPose) {
        rigRotation('hips', riggedPose.Hips.rotation as Euler, 0.7);
        rigPosition(
          'hips',
          {
            x: -(pose2d[0]?.x ?? 0) * 1.8 + 1.2,
            y: -(pose2d[0]?.y ?? 0) * 1.8 + 1.8,
            z: -(pose2d[0]?.z ?? 0) * 1.5 + 1.5,
          },
          1,
          0.07,
        );
        rigRotation('chest', riggedPose.Spine as Euler, 0.25, 0.3);
        rigRotation('spine', riggedPose.Spine as Euler, 0.45, 0.3);
        // No side crossing here: Kalidokit's Left outputs already come from
        // the person's right arm (mirror view). Crossing them (as the legacy
        // code did) applies each side's sign conventions to the opposite
        // bone, which flips the arms upside down.
        rigRotation('leftUpperArm', riggedPose.LeftUpperArm as Euler, 1, 0.3);
        rigRotation('leftLowerArm', riggedPose.LeftLowerArm as Euler, 1, 0.3);
        rigRotation('rightUpperArm', riggedPose.RightUpperArm as Euler, 1, 0.3);
        rigRotation('rightLowerArm', riggedPose.RightLowerArm as Euler, 1, 0.3);
      }
    } else {
      restBody();
    }

    if (leftHand.length > 0) {
      const r = trySolve(() => Kalidokit.Hand.solve(leftHand, 'Left'));
      if (r)
        applyHand(
          'left',
          r as unknown as Record<string, Euler>,
          (riggedPose?.LeftHand as Vec3 | undefined)?.z ?? 0,
        );
    } else {
      restHand('left');
    }
    if (rightHand.length > 0) {
      const r = trySolve(() => Kalidokit.Hand.solve(rightHand, 'Right'));
      if (r)
        applyHand(
          'right',
          r as unknown as Record<string, Euler>,
          (riggedPose?.RightHand as Vec3 | undefined)?.z ?? 0,
        );
    } else {
      restHand('right');
    }
  }

  return {
    async preload(): Promise<void> {
      canvas = document.createElement('canvas');
      canvas.style.cssText =
        'position:fixed;inset:0;width:100%;height:100%;z-index:5;pointer-events:none;';

      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 10);
      camera.position.set(0, 1.4, 0.7);
      camera.lookAt(0, 1.4, 0);

      // Close to the legacy setup (one directional at intensity 1): MToon
      // materials blow out to white under stronger rigs.
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
      try {
        const gltf = await loader.loadAsync(deps.assetUrl('aria/models/papa_de_him_chan.vrm'));
        const loaded = gltf.userData.vrm as VRM | undefined;
        if (loaded && scene) {
          vrm = loaded;
          vrm.scene.rotation.y = Math.PI;
          scene.add(vrm.scene);
          restBody(1); // start relaxed (arms down), not in the T-pose.
        } else {
          loadFailed = true;
        }
      } catch (err) {
        deps.rt.log.warn('aria: VRM load failed', { err: String(err) });
        loadFailed = true;
      }
    },

    start(): void {
      if (canvas && !canvas.isConnected) document.body.appendChild(canvas);
      resize();
      window.addEventListener('resize', resize);
      clock.getDelta();
    },

    render(frame: FrameContext): void {
      if (loadFailed) {
        drawPlaceholder(frame.ctx);
        return;
      }
      if (!renderer || !scene || !camera) return;
      animate(frame.timestamp);
      if (vrm) {
        vrm.update(clock.getDelta());
        vrm.scene.position.set(0, 0, -1);
      }
      renderer.render(scene, camera);
    },

    stop(): void {
      window.removeEventListener('resize', resize);
      canvas?.remove();
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
  visibility?: number;
}

/**
 * Convert raw landmark tuples to Kalidokit landmark objects. 2D face/pose/hand
 * landmarks are normalised by the camera frame size (matching the legacy
 * scene.js, including passing the third component through as z); world
 * landmarks (`metric`) are passed through in meters.
 */
function toLandmarks(
  arr: Landmark[],
  metric: boolean,
  imageSize: { width: number; height: number },
): KLandmark[] {
  const out: KLandmark[] = [];
  for (const lm of arr) {
    if (!lm || lm.length < 2) continue;
    if (metric) {
      out.push({ x: lm[0]!, y: lm[1]!, z: lm[2] ?? 0, visibility: lm[3] });
    } else {
      out.push({
        x: lm[0]! / imageSize.width,
        y: lm[1]! / imageSize.height,
        z: lm[2] ?? 0,
        visibility: lm[2],
      });
    }
  }
  return out;
}

/** Run a Kalidokit solve, tolerating internal errors (e.g. missing iris pts). */
function trySolve<T>(solve: () => T | undefined | null): T | undefined {
  try {
    return solve() ?? undefined;
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
  drawText(
    ctx,
    'Aria',
    REF_WIDTH / 2,
    REF_HEIGHT / 2 - 30,
    64,
    'rgba(255,255,255,0.85)',
    'center',
    'middle',
  );
  drawText(
    ctx,
    'VRM avatar model could not be loaded',
    REF_WIDTH / 2,
    REF_HEIGHT / 2 + 40,
    28,
    'rgba(255,255,255,0.5)',
    'center',
    'middle',
  );
}
