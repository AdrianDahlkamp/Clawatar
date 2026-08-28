/**
 * Unity .anim pose loader — converts VRChat VRIK pose captures into VRM poses.
 *
 * Source format: Unity AnimationClip YAML with classID-95 float curves:
 *   RootT.x/y/z, RootQ.x/y/z/w        — root (hips) position/rotation in avatar space
 *   LeftHandT/LeftHandQ, RightHandT.. — hand IK targets (avatar space)
 *   LeftFootT/LeftFootQ, RightFootT.. — foot IK targets
 *   "<Bone> <DoF>" muscle curves      — e.g. "Spine Front-Back" (optional)
 *   LeftHand.Finger.Spread/Stretched  — finger curls (optional, applied via expression-like curls)
 *
 * Conversion: two-bone analytic IK against the REAL VRM rig (three-vrm normalized
 * humanoid), so no canonical-skeleton assumptions. Static poses only (time 0).
 */
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'

// ---------- tiny math ----------
type Quat = [number, number, number, number]
type Vec3 = [number, number, number]

const qMul = (a: Quat, b: Quat): Quat => [
  a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
  a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
  a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
  a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
]
const qConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]]
const qNorm = (q: Quat): Quat => {
  const n = Math.hypot(...q)
  return n < 1e-9 ? [0, 0, 0, 1] : (q.map(v => v / n) as Quat)
}
const qVec = (q: Quat, v: Vec3): Vec3 => {
  const t: Vec3 = [
    2*(q[1]*v[2] - q[2]*v[1]),
    2*(q[2]*v[0] - q[0]*v[2]),
    2*(q[0]*v[1] - q[1]*v[0]),
  ]
  return [
    v[0] + q[3]*t[0] + (q[1]*t[2] - q[2]*t[1]),
    v[1] + q[3]*t[1] + (q[2]*t[0] - q[0]*t[2]),
    v[2] + q[3]*t[2] + (q[0]*t[1] - q[1]*t[0]),
  ]
}
const vAdd = (a: Vec3, b: Vec3): Vec3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]]
const vSub = (a: Vec3, b: Vec3): Vec3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]]
const vScale = (a: Vec3, s: number): Vec3 => [a[0]*s, a[1]*s, a[2]*s]
const vDot = (a: Vec3, b: Vec3) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
const vLen = (a: Vec3) => Math.hypot(...a)
const vNorm = (a: Vec3): Vec3 => {
  const l = vLen(a)
  return l < 1e-9 ? [0, 0, 0] : (a.map(v => v/l) as Vec3)
}
const vCross = (a: Vec3, b: Vec3): Vec3 => [
  a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0],
]
/** quaternion rotating unit vector a onto b */
const vFromTo = (a: Vec3, b: Vec3): Quat => {
  const c = vCross(a, b)
  const d = vDot(a, b)
  if (d > 1 - 1e-6) return [0, 0, 0, 1]
  if (d < -1 + 1e-6) {
    const axis: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const ax = vNorm(vCross(a, axis))
    return [ax[0], ax[1], ax[2], 0]
  }
  return qNorm([c[0], c[1], c[2], 1 + d])
}

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

  // Curve blocks in m_FloatCurves: "- serializedVersion: N\n curve: ... attribute: X\n path: Y\n classID: Z"
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

// ---------- humanoid stream layout ----------
// Unity humanoid animation stream (Unity 5+): index-order within classID-95 custom bindings,
// named curves here — RootT/RootQ/HandT/HandQ/FootT/FootQ + named muscles.
interface IKTargets {
  rootT: Vec3
  rootQ: Quat
  leftHandT?: Vec3
  leftHandQ?: Quat
  rightHandT?: Vec3
  rightHandQ?: Quat
  leftFootT?: Vec3
  leftFootQ?: Quat
  rightFootT?: Vec3
  rightFootQ?: Quat
}

const readIK = (a: ParsedAnim, t = 0): IKTargets => {
  const v3 = (b: string): Vec3 | undefined =>
    a.curves.has(`${b}.x`) || a.curves.has(`${b}.y`) || a.curves.has(`${b}.z`)
      ? [sample(a.curves.get(`${b}.x`), t), sample(a.curves.get(`${b}.y`), t), sample(a.curves.get(`${b}.z`), t)]
      : undefined
  const q4 = (b: string): Quat | undefined =>
    a.curves.has(`${b}.x`) || a.curves.has(`${b}.w`)
      ? [sample(a.curves.get(`${b}.x`), t), sample(a.curves.get(`${b}.y`), t), sample(a.curves.get(`${b}.z`), t), sample(a.curves.get(`${b}.w`), t)]
      : undefined
  return {
    rootT: v3('RootT') ?? [0, 0, 0],
    rootQ: q4('RootQ') ?? [0, 0, 0, 1],
    leftHandT: v3('LeftHandT'), leftHandQ: q4('LeftHandQ'),
    rightHandT: v3('RightHandT'), rightHandQ: q4('RightHandQ'),
    leftFootT: v3('LeftFootT'), leftFootQ: q4('LeftFootQ'),
    rightFootT: v3('RightFootT'), rightFootQ: q4('RightFootQ'),
  }
}

// ---------- two-bone analytic IK ----------
/**
 * Solve 2-bone chain: shoulder at S, mid joint M, end E (rest world dirs from S).
 * Target T (world). Returns local rotations for upper and lower bone in the
 * parent-space orientation chain provided.
 */
function solveTwoBone(
  sLen: number, mLen: number, target: Vec3,
): { cosMid: number; pole: number } | null {
  const d = vLen(target)
  if (d < 1e-6) return null
  const clamped = Math.min(d, sLen + mLen - 1e-4)
  // law of cosines at the mid joint between the two bones
  const cosMid = Math.min(1, Math.max(-1,
    (sLen*sLen + mLen*mLen - clamped*clamped) / (2*sLen*mLen)))
  return { cosMid, pole: 0 }
}

// ---------- main converter ----------
export interface ConvertedPose {
  rotations: Map<string, Quat>   // humanBoneName -> local rotation relative to T-pose rest
  positions: Map<string, Vec3>   // humanBoneName -> local position delta from rest
}

// Unity avatar space → glTF/VRM space: Unity +Z forward (away from viewer),
// VRM faces +Z? three-vrm normalized rig: VRM0 T-pose faces +Z in three-space.
// We map Unity(X right, Y up, Z forward) → glTF(X right, Y up, Z back).
// Assume these captures use Unity avatar space with Y-up; the safe guess is a
// 180° flip around Y. We make it a knob.
const UNITY_FLIP_Y = true

export function convertPose(parsed: ParsedAnim, vrm: VRM, t = 0): ConvertedPose {
  const humanoid = vrm.humanoid!
  const ik = readIK(parsed, t)
  const rotations = new Map<string, Quat>()
  const positions = new Map<string, Vec3>()

  // helper: world position of a bone node (rest pose assumed unchanged)
  const bonePos = (name: string): Vec3 | null => {
    const node = humanoid.getNormalizedBoneNode(name as never)
    if (!node) return null
    const p = new THREE.Vector3()
    node.getWorldPosition(p)
    return [p.x, p.y, p.z]
  }
  const boneWorldQuat = (name: string): Quat => {
    const node = humanoid.getNormalizedBoneNode(name as never)!
    const q = new THREE.Quaternion()
    node.getWorldQuaternion(q)
    return [q.x, q.y, q.z, q.w]
  }
  // local rest quaternion (T-pose) of a normalized bone
  const boneLocalQuat = (name: string): Quat => {
    const node = humanoid.getNormalizedBoneNode(name as never)!
    return [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w]
  }

  // ---- space conversion Unity → three (VRM rig) ----
  // Unity: X right, Y up, Z forward. glTF: X right, Y up, Z toward viewer.
  // For VRC pose captures: flip X and Z (Y rotation by 180°).
  // Knob: if poses come out mirrored/rotated, adjust here.
  const toWorld = (p: Vec3): Vec3 => UNITY_FLIP_Y ? [-p[0], p[1], -p[2]] : [p[0], p[1], p[2]]
  const toWorldQ = (q: Quat): Quat => {
    const flip: Quat = [0, 1, 0, 0]
    return UNITY_FLIP_Y ? qNorm(qMul(flip, qMul(q, flip))) : q
  }

  // Root (hips): position + rotation
  // RootT is in avatar root space; the VRM hips rest position sits at its own
  // rest world position. Delta applies to hips node position.
  const hipsRest = bonePos('hips')
  if (hipsRest) {
    const rootWorld = toWorld(ik.rootT)
    // many captures normalize avatar origin to the ground below the avatar;
    // the hips offset = rootWorld - (hips rest, since rest IS T-pose origin)
    const delta = rootWorld
    positions.set('hips', delta)
  }
  rotations.set('hips', toWorldQ(ik.rootQ))

  // ---- arm IK ----
  const armChain = (side: 'left' | 'right') => {
    const shoulder = `${side}Shoulder`
    const upper = `${side}UpperArm`
    const lower = `${side}LowerArm`
    const hand = `${side}Hand`
    const handT = side === 'left' ? ik.leftHandT : ik.rightHandT
    const handQ = side === 'left' ? ik.leftHandQ : ik.rightHandQ
    if (!handT) return

    // rest positions & lengths
    const s = bonePos(upper)  // upperArm world pos
    const m = bonePos(lower)
    const e = bonePos(hand)
    if (!s || !m || !e) return
    const sLen = vLen(vSub(m, s))
    const mLen = vLen(vSub(e, m))

    // target in world (VRM rig space)
    const target = toWorld(handT)
    const dir = vSub(target, s)
    const solve = solveTwoBone(sLen, mLen, dir)
    if (!solve) return

    // rest chain direction (upper->hand at T-pose) in world
    const restDir = vSub(e, s)
    const bendAxisRef = vCross(vNorm(restDir), [0, 1, 0])  // elbow bends around this

    // 1) rotate whole chain toward target
    const aimQ = vFromTo(vNorm(restDir), vNorm(dir))
    // 2) bend at elbow by angle between bones
    const cosMid = solve.cosMid
    const bendAngle = Math.acos(Math.min(1, Math.max(-1, cosMid)))
    const bendWorldAxis = vNorm(bendAxisRef)
    const aimQ4 = aimQ
    const bendQ = qMul(aimQ4, [bendWorldAxis[0]*Math.sin(bendAngle/2), bendWorldAxis[1]*Math.sin(bendAngle/2), bendWorldAxis[2]*Math.sin(bendAngle/2), Math.cos(bendAngle/2)])

    // upper rotation: world orientation = bendQ applied from rest world
    const upperRestWorld = boneWorldQuat(upper)
    const upperWorldNew = qMul(bendQ, upperRestWorld)
    const upperParentWorld = boneWorldQuat('chest' /* approximate parent via world chain */)
    // Note: three-vrm normalized bones hierarchy: upperArm's parent is shoulder.
    // Compute parent world as parent node's world quaternion:
    const upperNode = humanoid.getNormalizedBoneNode(upper as never)!
    const parentQ = new THREE.Quaternion()
    upperNode.parent!.getWorldQuaternion(parentQ)
    const qU = qNorm(qMul(qConj([parentQ.x, parentQ.y, parentQ.z, parentQ.w]), upperWorldNew))
    rotations.set(upper, qU)

    // lower: forearm rotation from same bend (world = rest * bend-around-axis)
    const lowerNode = humanoid.getNormalizedBoneNode(lower as never)!
    const lowerParentQ = new THREE.Quaternion()
    lowerNode.parent!.getWorldQuaternion(lowerParentQ)
    // forearm world orientation after bend: rotate rest world quat by bendQ
    const lowerRestWorld = boneWorldQuat(lower)
    const lowerWorldNew = qMul(bendQ, lowerRestWorld)
    const qL = qNorm(qMul(qConj([lowerParentQ.x, lowerParentQ.y, lowerParentQ.z, lowerParentQ.w]), lowerWorldNew))
    rotations.set(lower, qL)

    // hand: use IK rotation directly if provided
    if (handQ) {
      const handNode = humanoid.getNormalizedBoneNode(hand as never)!
      const handParentQ = new THREE.Quaternion()
      handNode.parent!.getWorldQuaternion(handParentQ)
      const handWorldUnity = toWorldQ(handQ)
      const qH = qNorm(qMul(qConj([handParentQ.x, handParentQ.y, handParentQ.z, handParentQ.w]), handWorldUnity))
      rotations.set(hand, qH)
    }
  }
  armChain('left')
  armChain('right')

  // ---- leg IK ----
  const legChain = (side: 'left' | 'right') => {
    const upper = `${side}UpperLeg`
    const lower = `${side}LowerLeg`
    const foot = `${side}Foot`
    const footT = side === 'left' ? ik.leftFootT : ik.rightFootT
    const footQ = side === 'left' ? ik.leftFootQ : ik.rightFootQ
    if (!footT) return

    const s = bonePos(upper), m = bonePos(lower), e = bonePos(foot)
    if (!s || !m || !e) return
    const sLen = vLen(vSub(m, s))
    const mLen = vLen(vSub(e, m))
    const target = toWorld(footT)
    const dir = vSub(target, s)
    const solve = solveTwoBone(sLen, mLen, dir)
    if (!solve) return

    const restDir = vSub(e, s)
    const bendAxisRef = vNorm(vCross(vNorm(restDir), [1, 0, 0]))
    const aimQ = vFromTo(vNorm(restDir), vNorm(dir))
    const bendAngle = Math.acos(Math.min(1, Math.max(-1, solve.cosMid)))
    const bendQ = qMul(aimQ, [
      bendAxisRef[0]*Math.sin(bendAngle/2),
      bendAxisRef[1]*Math.sin(bendAngle/2),
      bendAxisRef[2]*Math.sin(bendAngle/2),
      Math.cos(bendAngle/2),
    ])

    const upperNode = humanoid.getNormalizedBoneNode(upper as never)!
    const uq = new THREE.Quaternion()
    upperNode.parent!.getWorldQuaternion(uq)
    const upperRestWorld = boneWorldQuat(upper)
    const upperWorldNew = qMul(bendQ, upperRestWorld)
    rotations.set(upper, qNorm(qMul(qConj([uq.x, uq.y, uq.z, uq.w]), upperWorldNew)))

    const lowerNode = humanoid.getNormalizedBoneNode(lower as never)!
    const lq = new THREE.Quaternion()
    lowerNode.parent!.getWorldQuaternion(lq)
    const lowerRestWorld = boneWorldQuat(lower)
    const lowerWorldNew = qMul(bendQ, lowerRestWorld)
    rotations.set(lower, qNorm(qMul(qConj([lq.x, lq.y, lq.z, lq.w]), lowerWorldNew)))

    if (footQ) {
      const footNode = humanoid.getNormalizedBoneNode(foot as never)!
      const fq = new THREE.Quaternion()
      footNode.parent!.getWorldQuaternion(fq)
      const footWorldUnity = toWorldQ(footQ)
      rotations.set(foot, qNorm(qMul(qConj([fq.x, fq.y, fq.z, fq.w]), footWorldUnity)))
    }
  }
  legChain('left')
  legChain('right')

  // ---- fingers ----
  // Unity finger curl: LeftHand.Finger.1..3 Stretched (-1..1), Spread
  // Without finger bone animation in the VRM normalized rig we skip for now
  // (three-vrm normalized humanoid exposes finger bones — TODO map curls)

  return { rotations, positions }
}

// ---------- apply pose ----------
export function applyPose(vrm: VRM, pose: ConvertedPose): void {
  const humanoid = vrm.humanoid!
  for (const [bone, q] of pose.rotations) {
    const node = humanoid.getNormalizedBoneNode(bone as never)
    if (!node) continue
    if (![q[0], q[1], q[2], q[3]].every(Number.isFinite)) continue // NaN guard
    // IK-derived values ARE final local rotations — set directly
    node.quaternion.set(q[0], q[1], q[2], q[3])
  }
  for (const [bone, p] of pose.positions) {
    const node = humanoid.getNormalizedBoneNode(bone as never)
    if (!node) continue
    // hips: rest position was cached via storeRestPositions at load (or in playUnityPose)
    const rx = node.userData.__restX ?? node.position.x
    const ry = node.userData.__restY ?? node.position.y
    const rz = node.userData.__restZ ?? node.position.z
    node.position.set(
      Number.isFinite(p[0]) ? p[0] + rx : rx,
      Number.isFinite(p[1]) ? p[1] + ry : ry,
      Number.isFinite(p[2]) ? p[2] + rz : rz,
    )
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