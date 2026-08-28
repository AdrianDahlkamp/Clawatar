/**
 * Unity .anim pose loader — converts VRChat VRIK pose captures into VRM poses.
 *
 * Source format: Unity AnimationClip YAML with classID-95 float curves:
 *   RootT.x/y/z, RootQ.x/y/z/w        — root (hips) position/rotation (avatar space, meters)
 *   LeftHandT/LeftHandQ, RightHandT.. — hand IK targets (avatar space)
 *   LeftFootT/LeftFootQ, RightFootT.. — foot IK targets
 *
 * Conversion: analytic 2-bone IK against the REAL VRM rig (three-vrm normalized
 * humanoid), so no canonical-skeleton assumptions. Static poses only (t=0).
 *
 * Kalibrier-Knobs (Konsole, live änderbar):
 *   __poseCal.flipY       — Unity→glTF 180°-Y-Mapping (default true)
 *   __poseCal.hipsScale   — Hüft-Position skalieren, falls Avatar-Größe abweicht
 *   __poseCal.armBendSign — +1/-1 Ellenbogen-Bendrichtung
 *   __poseCal.legBendSign — +1/-1 Knie-Bendrichtung (default -1 = Knie nach hinten)
 */
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

type Vec3 = [number, number, number]

// ---------- .anim parsing ----------
export interface ParsedAnim {
  name: string
  curves: Map<string, Array<{ t: number; v: number }>>
}

export function parseUnityAnim(text: string): ParsedAnim {
  const nameMatch = text.match(/m_Name: (.+)/)
  const cut = text.indexOf('m_ClipBindingConstant')
  const body = cut === -1 ? text : text.slice(0, cut)
  const curves = new Map<string, Array<{ t: number; v: number }>>()
  const blocks = body.split(/\n  - serializedVersion: \d+\n/)
  for (const block of blocks) {
    const attrMatch = block.match(/attribute: ([^\n]+)\s*\n\s+path: ([^\n]*)\n\s+classID: (\d+)/)
    if (!attrMatch) continue
    if (attrMatch[3].trim() !== '95') continue
    const attr = attrMatch[1].trim()
    const vals = [...block.matchAll(/time: (-?[\d.e+]+)\s*\n\s+value: (-?[\d.e-]+)/g)]
    if (vals.length === 0) continue
    curves.set(attr, vals.map(m => ({ t: parseFloat(m[1]), v: parseFloat(m[2]) })))
  }
  return { name: nameMatch?.[1]?.trim() || 'pose', curves }
}

function sample(curve: Array<{ t: number; v: number }> | undefined, t = 0): number {
  if (!curve || curve.length === 0) return 0
  if (curve.length === 1) return curve[0].v
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i], b = curve[i+1]
    if (a.t <= t && t <= b.t) {
      const f = b.t - a.t < 1e-9 ? 0 : (t - a.t) / (b.t - a.t)
      return a.v + f * (b.v - a.v)
    }
  }
  return t >= curve[curve.length-1].t ? curve[curve.length-1].v : curve[0].v
}

// ---------- calibration knobs ----------
export interface PoseCal {
  flipY: boolean
  hipsScale: number
  armBendSign: number
  legBendSign: number
}
const DEFAULT_CAL: PoseCal = { flipY: true, hipsScale: 1.0, armBendSign: 1, legBendSign: -1 }
if (typeof window !== 'undefined') {
  ;(window as any).__poseCal = { ...DEFAULT_CAL }
}
function getCal(): PoseCal {
  if (typeof window === 'undefined') return DEFAULT_CAL
  return { ...DEFAULT_CAL, ...((window as any).__poseCal ?? {}) }
}

// ---------- IK targets ----------
interface IKTargets {
  rootT: Vec3 | null
  rootQ: [number, number, number, number] | null
  leftHandT?: Vec3
  leftHandQ?: [number, number, number, number]
  rightHandT?: Vec3
  rightHandQ?: [number, number, number, number]
  leftFootT?: Vec3
  leftFootQ?: [number, number, number, number]
  rightFootT?: Vec3
  rightFootQ?: [number, number, number, number]
}

const readIK = (a: ParsedAnim, t = 0): IKTargets => {
  const v3 = (b: string): Vec3 | undefined =>
    a.curves.has(`${b}.x`) ? [sample(a.curves.get(`${b}.x`), t), sample(a.curves.get(`${b}.y`), t), sample(a.curves.get(`${b}.z`), t)] : undefined
  const q4 = (b: string): [number, number, number, number] | undefined =>
    a.curves.has(`${b}.w`) ? [sample(a.curves.get(`${b}.x`), t), sample(a.curves.get(`${b}.y`), t), sample(a.curves.get(`${b}.z`), t), sample(a.curves.get(`${b}.w`), t)] : undefined
  return {
    rootT: v3('RootT') ?? null, rootQ: q4('RootQ') ?? null,
    leftHandT: v3('LeftHandT'), leftHandQ: q4('LeftHandQ'),
    rightHandT: v3('RightHandT'), rightHandQ: q4('RightHandQ'),
    leftFootT: v3('LeftFootT'), leftFootQ: q4('LeftFootQ'),
    rightFootT: v3('RightFootT'), rightFootQ: q4('RightFootQ'),
  }
}

const clamp = (v: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v))
const FORWARD = new THREE.Vector3(0, 0, 1)

// ---------- main converter ----------
export interface ConvertedPose {
  rotations: Map<string, THREE.Quaternion>
  positions: Map<string, THREE.Vector3>
}

export function convertPose(parsed: ParsedAnim, vrm: VRM, t = 0): ConvertedPose {
  const humanoid = vrm.humanoid!
  const ik = readIK(parsed, t)
  const cal = getCal()
  const rotations = new Map<string, THREE.Quaternion>()
  const positions = new Map<string, THREE.Vector3>()

  const bone = (name: string) => humanoid.getNormalizedBoneNode(name as never)
  const wp = (name: string) => {
    const n = bone(name)
    return n ? n.getWorldPosition(new THREE.Vector3()) : null
  }
  const wq = (name: string) => {
    const n = bone(name)
    return n ? n.getWorldQuaternion(new THREE.Quaternion()) : null
  }
  const parentWq = (name: string) => {
    const n = bone(name)
    return n?.parent ? n.parent.getWorldQuaternion(new THREE.Quaternion()) : null
  }

  // Unity → glTF space mapping (180° around Y): X right stays, Z forward flips
  const toPos = (p: Vec3) => new THREE.Vector3(cal.flipY ? -p[0] : p[0], p[1], cal.flipY ? -p[2] : p[2])
  const FLIP = new THREE.Quaternion(0, 1, 0, 0)
  const toQuat = (q: [number, number, number, number]) => {
    const raw = new THREE.Quaternion(q[0], q[1], q[2], q[3])
    return cal.flipY ? FLIP.clone().multiply(raw).multiply(FLIP) : raw
  }

  // ---- hips: position = ABSOLUTE (rootT is height over ground, not delta!) ----
  if (ik.rootT) {
    const hipsNode = bone('hips')
    if (hipsNode) {
      const ry = (hipsNode.userData.__restY as number | undefined) ?? hipsNode.position.y
      const p = toPos(ik.rootT)
      p.y = cal.hipsScale !== 1.0 ? p.y * cal.hipsScale : p.y
      // keep margins: x/z from capture relative to rig ground origin
      positions.set('hips', p)
      void ry
    }
  }
  if (ik.rootQ) {
    const hipsParentQ = parentWq('hips')
    if (hipsParentQ) {
      rotations.set('hips', hipsParentQ.clone().invert().multiply(toQuat(ik.rootQ)))
    }
  }

  // ---- shared 2-bone analytic IK ----
  const solveLimb = (
    upperName: string, lowerName: string, endName: string,
    targetT: Vec3, targetQ: [number, number, number, number] | undefined,
    bendSign: number,
  ) => {
    const S = wp(upperName), M = wp(lowerName), E = wp(endName)
    if (!S || !M || !E) return
    const a = S.distanceTo(M)
    const b = M.distanceTo(E)
    const T = toPos(targetT)

    const dir = T.clone().sub(S)
    const d = Math.min(dir.length(), (a + b) * 0.9999)
    if (d < 1e-6) return
    dir.normalize()

    // shoulder angle: between chain direction and upper bone
    const cosAlpha = clamp((a*a + d*d - b*b) / (2*a*d))
    const alpha = Math.acos(cosAlpha)
    // interior elbow angle → flexion deficit from straight
    const betaInt = Math.acos(clamp((a*a + b*b - d*d) / (2*a*b)))
    const flex = Math.PI - betaInt

    // rest chain direction + bend axis (world)
    const u1 = M.clone().sub(S).normalize()
    let axisRest = new THREE.Vector3().crossVectors(u1, FORWARD)
    if (axisRest.lengthSq() < 1e-6) axisRest = FORWARD.clone()
    axisRest.normalize()

    const qAim = new THREE.Quaternion().setFromUnitVectors(u1, dir)
    const aimAxis = axisRest.clone().applyQuaternion(qAim).normalize()

    // upper: aim toward target, then rotate upper bone BACK by alpha along the
    // bend axis so the (flexed) forearm end lands on the target
    const upperRestWorldQ = wq(upperName)!
    const qShoulder = new THREE.Quaternion()
      .setFromAxisAngle(aimAxis, -alpha * bendSign)
      .multiply(qAim)
    const upperWorldNew = qShoulder.clone().multiply(upperRestWorldQ)
    const upperParentQ = parentWq(upperName)!
    rotations.set(upperName, upperParentQ.clone().invert().multiply(upperWorldNew))

    // lower: relative flex at the elbow/knee around the bone-local hinge axis
    const lowerRestWorldQ = wq(lowerName)!
    const localAxis = axisRest.clone().applyQuaternion(upperRestWorldQ.clone().invert())
    const qHinge = new THREE.Quaternion().setFromAxisAngle(localAxis, flex * bendSign)
    const lowerWorldNew = upperWorldNew.clone()
      .multiply(upperRestWorldQ.clone().invert())
      .multiply(qHinge)
      .multiply(lowerRestWorldQ)
    const lowerParentQ = parentWq(lowerName)!
    rotations.set(lowerName, lowerParentQ.clone().invert().multiply(lowerWorldNew))

    // end effector: direct IK rotation
    if (targetQ) {
      const endParentQ = parentWq(endName)!
      rotations.set(endName, endParentQ.clone().invert().multiply(toQuat(targetQ)))
    }
  }

  if (ik.leftHandT) solveLimb('leftUpperArm', 'leftLowerArm', 'leftHand', ik.leftHandT, ik.leftHandQ, cal.armBendSign)
  if (ik.rightHandT) solveLimb('rightUpperArm', 'rightLowerArm', 'rightHand', ik.rightHandT, ik.rightHandQ, cal.armBendSign)
  if (ik.leftFootT) solveLimb('leftUpperLeg', 'leftLowerLeg', 'leftFoot', ik.leftFootT, ik.leftFootQ, cal.legBendSign)
  if (ik.rightFootT) solveLimb('rightUpperLeg', 'rightLowerLeg', 'rightFoot', ik.rightFootT, ik.rightFootQ, cal.legBendSign)

  return { rotations, positions }
}

// ---------- apply pose ----------
export function applyPose(vrm: VRM, pose: ConvertedPose): void {
  const humanoid = vrm.humanoid!
  for (const [boneName, q] of pose.rotations) {
    const node = humanoid.getNormalizedBoneNode(boneName as never)
    if (!node) continue
    if (![q.x, q.y, q.z, q.w].every(Number.isFinite)) continue
    node.quaternion.copy(q)
  }
  for (const [boneName, p] of pose.positions) {
    const node = humanoid.getNormalizedBoneNode(boneName as never)
    if (!node) continue
    if (![p.x, p.y, p.z].every(Number.isFinite)) continue
    // absolute mapping: rootT IS the avatar-space position (meters over ground)
    node.position.copy(p)
  }
}

export function storeRestPositions(vrm: VRM): void {
  const humanoid = vrm.humanoid!
  const list = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
    'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']
  for (const name of list) {
    const node = humanoid.getNormalizedBoneNode(name as never)
    if (!node) continue
    if (node.userData.__restX === undefined) {
      node.userData.__restX = node.position.x
      node.userData.__restY = node.position.y
      node.userData.__restZ = node.position.z
    }
  }
}