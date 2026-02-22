import { state } from './app-state'

let breathingEnabled = true
let breathPhase = 0
let lastVRMScene: object | null = null

interface BreathingOffsets {
  spineX: number
  chestX: number
  hipsZ: number
  hipsY: number
  headX: number
  headY: number
  leftShoulderZ: number
  rightShoulderZ: number
}

const lastOffsets: BreathingOffsets = {
  spineX: 0,
  chestX: 0,
  hipsZ: 0,
  hipsY: 0,
  headX: 0,
  headY: 0,
  leftShoulderZ: 0,
  rightShoulderZ: 0,
}

function clearOffsets(): void {
  lastOffsets.spineX = 0
  lastOffsets.chestX = 0
  lastOffsets.hipsZ = 0
  lastOffsets.hipsY = 0
  lastOffsets.headX = 0
  lastOffsets.headY = 0
  lastOffsets.leftShoulderZ = 0
  lastOffsets.rightShoulderZ = 0
}

function removeCurrentOffsets(): void {
  const humanoid = state.vrm?.humanoid
  if (!humanoid) return

  const spine = humanoid.getNormalizedBoneNode('spine')
  const chest = humanoid.getNormalizedBoneNode('chest')
  const hips = humanoid.getNormalizedBoneNode('hips')
  const head = humanoid.getNormalizedBoneNode('head')
  const leftShoulder = humanoid.getNormalizedBoneNode('leftShoulder')
  const rightShoulder = humanoid.getNormalizedBoneNode('rightShoulder')

  if (spine) spine.rotation.x -= lastOffsets.spineX
  if (chest) chest.rotation.x -= lastOffsets.chestX
  if (hips) {
    hips.rotation.z -= lastOffsets.hipsZ
    hips.position.y -= lastOffsets.hipsY
  }
  if (head) {
    head.rotation.x -= lastOffsets.headX
    head.rotation.y -= lastOffsets.headY
  }
  if (leftShoulder) leftShoulder.rotation.z -= lastOffsets.leftShoulderZ
  if (rightShoulder) rightShoulder.rotation.z -= lastOffsets.rightShoulderZ
}

/** Procedural breathing & micro-movement — additive bone layer */
export function updateBreathing(delta: number): void {
  if (!state.vrm) {
    clearOffsets()
    lastVRMScene = null
    return
  }

  if (lastVRMScene !== state.vrm.scene) {
    clearOffsets()
    lastVRMScene = state.vrm.scene
  }

  // Keep breathing as an idle-only additive layer.
  // During action/speaking clips, avoid extra bone perturbation that can amplify twists.
  if (!breathingEnabled || state.characterState !== 'idle') {
    removeCurrentOffsets()
    clearOffsets()
    return
  }

  const humanoid = state.vrm.humanoid
  if (!humanoid) return

  breathPhase += delta

  const spineX = Math.sin(breathPhase * 1.2) * 0.008
  const chestX = Math.sin(breathPhase * 1.2 + 0.3) * 0.005
  const hipsZ = Math.sin(breathPhase * 0.4) * 0.003
  const hipsY = Math.sin(breathPhase * 0.4) * 0.001
  const headX = Math.sin(breathPhase * 0.3) * 0.005
  const headY = Math.sin(breathPhase * 0.2 + 1.5) * 0.008
  const leftShoulderZ = Math.sin(breathPhase * 1.2) * 0.003
  const rightShoulderZ = Math.sin(breathPhase * 1.2 + Math.PI) * 0.003

  // 1. BREATHING — chest/spine rises and falls
  const spine = humanoid.getNormalizedBoneNode('spine')
  const chest = humanoid.getNormalizedBoneNode('chest')
  if (spine) spine.rotation.x += spineX - lastOffsets.spineX
  if (chest) chest.rotation.x += chestX - lastOffsets.chestX

  // 2. WEIGHT SHIFT — subtle hip sway
  const hips = humanoid.getNormalizedBoneNode('hips')
  if (hips) {
    hips.rotation.z += hipsZ - lastOffsets.hipsZ
    hips.position.y += hipsY - lastOffsets.hipsY
  }

  // 3. HEAD MICRO-MOVEMENT
  const head = humanoid.getNormalizedBoneNode('head')
  if (head) {
    head.rotation.x += headX - lastOffsets.headX
    head.rotation.y += headY - lastOffsets.headY
  }

  // 4. SHOULDER MICRO-MOVEMENT
  const leftShoulder = humanoid.getNormalizedBoneNode('leftShoulder')
  const rightShoulder = humanoid.getNormalizedBoneNode('rightShoulder')
  if (leftShoulder) leftShoulder.rotation.z += leftShoulderZ - lastOffsets.leftShoulderZ
  if (rightShoulder) rightShoulder.rotation.z += rightShoulderZ - lastOffsets.rightShoulderZ

  lastOffsets.spineX = spineX
  lastOffsets.chestX = chestX
  lastOffsets.hipsZ = hipsZ
  lastOffsets.hipsY = hipsY
  lastOffsets.headX = headX
  lastOffsets.headY = headY
  lastOffsets.leftShoulderZ = leftShoulderZ
  lastOffsets.rightShoulderZ = rightShoulderZ
}

export function setBreathingEnabled(enabled: boolean): void {
  if (breathingEnabled && !enabled) {
    removeCurrentOffsets()
    clearOffsets()
  }
  breathingEnabled = enabled
  if (!enabled) {
    breathPhase = 0
  }
}
