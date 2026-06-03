/**
 * Aria: a VRM avatar puppeted by the user's pose, hands and face.
 *
 * Ports the legacy `aria` app. The mirror landmarks (`pose_to_mirror`) are
 * solved into humanoid bone rotations and face blendshapes with Kalidokit, then
 * applied to a VRM model rendered with three.js + @pixiv/three-vrm (v3).
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

const IMAGE_SIZE = { width: REF_WIDTH, height: REF_HEIGHT };

/** Kalidokit finger key -> VRM1 bone name, per hand side. */
const FINGER_BONES = ['Index', 'Middle', 'Ring', 'Little'] as const;
const FINGER_PARTS = ['Proximal', 'Intermediate', 'Distal'] as const;

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
    bone.position.lerp(
      new THREE.Vector3(pos.x * dampener, pos.y * dampener, pos.z * dampener),
      lerpAmount,
    );
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

  function animate(): void {
    if (!vrm) return;
    const d = deps.feed.mirror.data;

    const face = toLandmarks(d.face_mesh, false);
    const pose2d = toLandmarks(d.body_pose, false);
    const pose3d = toLandmarks(d.body_world_pose ?? [], true);
    // Legacy swaps handedness for the mirror view.
    const leftHand = toLandmarks(d.right_hand_pose, false);
    const rightHand = toLandmarks(d.left_hand_pose, false);

    if (face.length > 0) {
      const riggedFace = Kalidokit.Face.solve(face, {
        runtime: 'mediapipe',
        imageSize: IMAGE_SIZE,
      });
      if (riggedFace) rigFace(riggedFace);
    }

    let riggedPose: Kalidokit.TPose | undefined;
    if (pose2d.length > 0 && pose3d.length > 0) {
      riggedPose =
        Kalidokit.Pose.solve(pose3d, pose2d, { runtime: 'mediapipe', imageSize: IMAGE_SIZE }) ??
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
        // Arms are mirrored (left<->right) for the reflection view.
        rigRotation('leftUpperArm', riggedPose.RightUpperArm as Euler, 1, 0.3);
        rigRotation('leftLowerArm', riggedPose.RightLowerArm as Euler, 1, 0.3);
        rigRotation('rightUpperArm', riggedPose.LeftUpperArm as Euler, 1, 0.3);
        rigRotation('rightLowerArm', riggedPose.LeftLowerArm as Euler, 1, 0.3);
      }
    }

    if (leftHand.length > 0) {
      const r = Kalidokit.Hand.solve(leftHand, 'Left');
      if (r)
        applyHand(
          'left',
          r as unknown as Record<string, Euler>,
          (riggedPose?.LeftHand as Vec3 | undefined)?.z ?? 0,
        );
    }
    if (rightHand.length > 0) {
      const r = Kalidokit.Hand.solve(rightHand, 'Right');
      if (r)
        applyHand(
          'right',
          r as unknown as Record<string, Euler>,
          (riggedPose?.RightHand as Vec3 | undefined)?.z ?? 0,
        );
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

      const light = new THREE.DirectionalLight(0xffffff, 1.5);
      light.position.set(1, 1, 1).normalize();
      scene.add(light);
      scene.add(new THREE.AmbientLight(0xffffff, 0.6));

      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      try {
        const gltf = await loader.loadAsync(deps.assetUrl('aria/models/papa_de_him_chan.vrm'));
        const loaded = gltf.userData.vrm as VRM | undefined;
        if (loaded && scene) {
          vrm = loaded;
          vrm.scene.rotation.y = Math.PI;
          scene.add(vrm.scene);
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
      animate();
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
 * Convert mirror-space landmark tuples to Kalidokit landmark objects. 2D/face/
 * hand landmarks are normalised by the reference image size; world landmarks
 * (`metric`) are passed through in meters.
 */
function toLandmarks(arr: Landmark[], metric: boolean): KLandmark[] {
  const out: KLandmark[] = [];
  for (const lm of arr) {
    if (!lm || lm.length < 2) continue;
    if (metric) {
      out.push({ x: lm[0]!, y: lm[1]!, z: lm[2] ?? 0, visibility: lm[3] });
    } else {
      out.push({
        x: lm[0]! / REF_WIDTH,
        y: lm[1]! / REF_HEIGHT,
        z: (lm[2] ?? 0) / REF_WIDTH,
        visibility: lm[3],
      });
    }
  }
  return out;
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
