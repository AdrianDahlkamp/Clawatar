import * as THREE from 'three'
import { camera, controls, BASE_FOV } from './scene'
import { state } from './app-state'
import { broadcastSyncCommand } from './sync-bridge'

type CameraPreset = 'face' | 'portrait' | 'full' | 'meeting'
type CameraFollowMode = 'head' | 'root' | 'fixed'

type CameraTransition = {
  startTime: number
  duration: number
  startPos: THREE.Vector3
  endPos: THREE.Vector3
  startTarget: THREE.Vector3
  endTarget: THREE.Vector3
}

// Adrian-Setup: genau 3 Presets (face/portrait/full).
// ALLE folgen dem Root (nur Translation, keine Kopf-Knochen-Wackler) und
// sitzen auf fester Kopfhöhe (~1.42 m über dem Boden) → kein Schwanken,
// kein Drift. Kamerahöhe = Kopfhöhe, Blickrichtung = Kopfhöhe.
const HEAD_HEIGHT = 1.42
const PRESETS: Record<CameraPreset, {
  // Offset from tracking anchor for camera position (z = distance in front)
  posOffset: THREE.Vector3
  // Offset from tracking anchor for look-at target
  targetOffset: THREE.Vector3
  // How this preset follows avatar motion
  followMode: CameraFollowMode
  // Extra rotation around the anchor (radians) — applied to posOffset.
  // 0 = frontal (Standard), PI*0.75 = 135° seitlich (Adrian-Default).
  azimuth?: number
}> = {
  face: {
    // Gesicht: nah dran, Kamera leicht UNTER Kopfhöhe → Kopf sitzt mittig-oben,
    // Bild wird vollflächig genutzt statt Kopf am unteren Rand
    posOffset: new THREE.Vector3(0, HEAD_HEIGHT - 0.12, 1.0),
    targetOffset: new THREE.Vector3(0, HEAD_HEIGHT - 0.06, 0),
    followMode: 'root',
  },
  portrait: {
    // Oberkörper: Kamera auf Kopfhöhe, Kopf+Torso füllt das Bild
    // Frontal (Azimut 0) — der Raumsicht-Winkel kommt über die Raum-Rotation,
    // nicht über die Kamera (Adrian-Korrektur, 28.08.2026)
    posOffset: new THREE.Vector3(0, HEAD_HEIGHT - 0.05, 1.5),
    targetOffset: new THREE.Vector3(0, HEAD_HEIGHT - 0.28, 0),
    followMode: 'root',
  },
  full: {
    // Full Body: Kamera auf Kopfhöhe, Blick leicht nach unten
    // (35° FOV — bei 2.6m passt 0..1.5m Körperhöhe komplett ins Bild)
    posOffset: new THREE.Vector3(0, HEAD_HEIGHT, 2.6),
    targetOffset: new THREE.Vector3(0, 0.82, 0),
    followMode: 'root',
  },
  meeting: {
    // Webcam-style: camera at chest level looking up at face (nur ?meeting-Modus)
    posOffset: new THREE.Vector3(-0.08, -0.38, 0.6),  // Left + slightly higher
    targetOffset: new THREE.Vector3(-0.08, -0.13, 0),  // Look at face, shifted left
    followMode: 'head',
  },
}

// User-facing distance/height sliders are normalized around 1.00 / 0.00.
// Baselines sind 1.0 / 0.0 — die Presets selbst tragen die echten Werte.
const PRESET_BASELINE: Record<CameraPreset, { distance: number; height: number }> = {
  face: { distance: 1.0, height: 0.0 },
  portrait: { distance: 1.0, height: 0.0 },
  full: { distance: 1.0, height: 0.0 },
  meeting: { distance: 1.0, height: 0.0 },
}

let transition: CameraTransition | null = null
let currentPreset: CameraPreset = 'portrait'
let trackingSmooth = new THREE.Vector3()  // Smoothed head position
let trackingInitialized = false
const safetyPush = new THREE.Vector3()
const safetyBonePos = new THREE.Vector3()
const SAFETY_BONES = ['head', 'neck', 'leftEye', 'rightEye'] as const
const SAFETY_SHELL: Record<CameraPreset, { head: number; neck: number; eyes: number; target: number }> = {
  face: { head: 0.85, neck: 0.75, eyes: 0.8, target: 0.75 },
  portrait: { head: 1.15, neck: 1.05, eyes: 1.1, target: 1.05 },
  full: { head: 1.7, neck: 1.5, eyes: 1.6, target: 1.45 },
  meeting: { head: 0.82, neck: 0.68, eyes: 0.74, target: 0.62 },
}

export function getCurrentCameraPreset(): string {
  return currentPreset
}

export function initCameraPresets() {
  const panel = document.getElementById('camera-preset-buttons')
  if (!panel) return

  panel.querySelectorAll<HTMLButtonElement>('[data-camera-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const presetId = button.dataset.cameraPreset as CameraPreset | undefined
      if (!presetId || !(presetId in PRESETS)) return

      setCameraPreset(presetId, 0.8)
      broadcastSyncCommand({
        type: 'set_camera_preset',
        preset: presetId,
        duration: 0.8,
      })
      pulseButton(button)
    })
  })
}

/** Get the VRM head bone world position */
function getHeadWorldPosition(): THREE.Vector3 | null {
  if (!state.vrm) return null
  const headBone = state.vrm.humanoid?.getNormalizedBoneNode('head')
  if (!headBone) return null
  const pos = new THREE.Vector3()
  headBone.getWorldPosition(pos)
  return pos
}

/** Get the VRM root world position */
function getRootWorldPosition(): THREE.Vector3 | null {
  if (!state.vrm) return null
  const pos = new THREE.Vector3()
  state.vrm.scene.getWorldPosition(pos)
  return pos
}

function getAnchorWorldPosition(mode: CameraFollowMode): THREE.Vector3 | null {
  if (mode === 'head') return getHeadWorldPosition()
  if (mode === 'root') return getRootWorldPosition()
  return null
}

export function updateCameraPresets(nowSeconds: number) {
  // Handle transition animation (smooth lerp to new preset)
  if (transition) {
    const t = Math.min(1, (nowSeconds - transition.startTime) / transition.duration)
    const eased = easeOutCubic(t)

    camera.position.lerpVectors(transition.startPos, transition.endPos, eased)
    controls.target.lerpVectors(transition.startTarget, transition.endTarget, eased)

    if (t >= 1) {
      transition = null
    }
    enforceCameraSafetyForPreset(currentPreset)
    return  // Don't track during transition
  }

  // Follow anchor (root/head) for tracking presets
  const preset = PRESETS[currentPreset]
  if (preset.followMode === 'fixed') return

  const anchorPos = getAnchorWorldPosition(preset.followMode)
  if (!anchorPos) return

  // Stabiles Tracking: Anchor nur leicht glätten (gegen Mikro-Jitter),
  // aber Kamera & Target DIREKT auf Anchor+offset setzen.
  // Die alte Doppel-Glättung (Anchor lerp + Kamera lerp) hat Lag erzeugt
  // → Avatar "schwamm" im Bild. Jetzt: starres Mitführen, null Wobble.
  const smoothing = 0.35
  if (!trackingInitialized) {
    trackingSmooth.copy(anchorPos)
    trackingInitialized = true
  } else {
    trackingSmooth.lerp(anchorPos, smoothing)
  }

  // Camera position = smoothed anchor + adjusted offset (user customizable)
  const adjusted = getAdjustedOffsets(currentPreset)
  const targetPos = trackingSmooth.clone().add(adjusted.targetOffset)
  const camPos = trackingSmooth.clone().add(adjusted.posOffset)

  camera.position.copy(camPos)
  controls.target.copy(targetPos)

  // Preset-FOV: 3D-Räume setzen oft breite FOVs (42–48°) für Diorama-Look —
  // das frisst Zoom. Tracking-Presets erzwingen wieder das Base-FOV.
  if (camera.fov !== BASE_FOV) {
    camera.fov = BASE_FOV
    camera.updateProjectionMatrix()
  }

  enforceCameraSafetyForPreset(currentPreset)
}

export function enforceCameraSafetyShell() {
  enforceCameraSafetyForPreset(currentPreset)
}

function enforceCameraSafetyForPreset(presetId: CameraPreset) {
  const humanoid = state.vrm?.humanoid
  if (!humanoid) return

  const shell = SAFETY_SHELL[presetId] ?? SAFETY_SHELL.portrait

  for (const boneName of SAFETY_BONES) {
    const node = humanoid.getNormalizedBoneNode(boneName)
    if (!node) continue

    node.getWorldPosition(safetyBonePos)
    safetyPush.copy(camera.position).sub(safetyBonePos)
    let dist = safetyPush.length()

    const minDistance = boneName === 'head'
      ? shell.head
      : boneName === 'neck'
        ? shell.neck
        : shell.eyes

    if (dist >= minDistance) continue

    if (dist > 1e-4) {
      safetyPush.divideScalar(dist)
    } else {
      safetyPush.copy(camera.position).sub(controls.target)
      const fallbackDist = safetyPush.length()
      if (fallbackDist > 1e-4) {
        safetyPush.divideScalar(fallbackDist)
      } else {
        safetyPush.set(0, 0, 1)
      }
      dist = 0
    }

    camera.position.addScaledVector(safetyPush, minDistance - dist)
  }

  // Extra guard: keep a minimum radius from orbit target to avoid near-plane face slicing.
  safetyPush.copy(camera.position).sub(controls.target)
  const targetDist = safetyPush.length()
  if (targetDist < shell.target) {
    if (targetDist > 1e-4) {
      safetyPush.divideScalar(targetDist)
    } else {
      safetyPush.set(0, 0, 1)
    }
    camera.position.addScaledVector(safetyPush, shell.target - targetDist)
  }
}

/** Set camera to a named preset (callable from WS commands) */
export function setCameraPreset(presetId: string, duration = 0.8) {
  const preset = PRESETS[presetId as CameraPreset]
  if (!preset) return false

  currentPreset = presetId as CameraPreset
  trackingInitialized = false  // Reset tracking smoothing

  if (preset.followMode !== 'fixed') {
    // For follow presets: transition to current anchor + adjusted offset
    const anchorPos = getAnchorWorldPosition(preset.followMode)
    if (anchorPos) {
      const adjusted = getAdjustedOffsets(presetId as CameraPreset)
      const endPos = anchorPos.clone().add(adjusted.posOffset)
      const endTarget = anchorPos.clone().add(adjusted.targetOffset)
      startTransition({ position: endPos, target: endTarget }, duration)
    }
  } else {
    // Non-tracking presets (momentan keins im UI)
    startTransition({ position: camera.position.clone(), target: controls.target.clone() }, duration)
  }

  return true
}

function startTransition(target: { position: THREE.Vector3; target: THREE.Vector3 }, duration: number) {
  transition = {
    startTime: performance.now() / 1000,
    duration,
    startPos: camera.position.clone(),
    endPos: target.position.clone(),
    startTarget: controls.target.clone(),
    endTarget: target.target.clone(),
  }
}

/** Adjust a preset's distance/height from WS or settings UI.
 *  distance: user multiplier around 1.0 (applied on top of preset baseline)
 *  height: user Y offset around 0.0 (added on top of preset baseline)
 */
export function adjustPresetOffset(presetId: string, distance: number, height: number) {
  const preset = PRESETS[presetId as CameraPreset]
  if (!preset) return false

  // Store custom offsets — applied as multiplier on Z and additive on Y
  customOffsets[presetId] = { distance, height }

  // If currently on this preset, re-trigger to apply
  if (currentPreset === presetId) {
    if (preset.followMode !== 'fixed') {
      trackingInitialized = false
    }
  }

  return true
}

// Custom user offsets per preset
const customOffsets: Record<string, { distance: number; height: number }> = {}

function getEffectiveAdjustment(presetId: CameraPreset) {
  const base = PRESET_BASELINE[presetId] ?? PRESET_BASELINE.face
  const user = customOffsets[presetId]
  const distance = (user?.distance ?? 1.0) * base.distance
  const height = (user?.height ?? 0.0) + base.height
  return { distance, height }
}

function getAdjustedOffsets(presetId: CameraPreset) {
  const preset = PRESETS[presetId]
  const effective = getEffectiveAdjustment(presetId)
  // Meeting mode also reads horizontal offset from calibration UI
  const hx = presetId === 'meeting' ? ((window as any).__meetingHorizontal ?? 0) : 0
  // Azimuth presets (e.g. portrait @ 135°): rotate the XZ part of posOffset
  // around the anchor. Distance scaling applies along the rotated radius.
  let px = preset.posOffset.x + hx
  let pz = preset.posOffset.z * effective.distance
  if (preset.azimuth) {
    const s = Math.sin(preset.azimuth)
    const c = Math.cos(preset.azimuth)
    const rx = px * c + pz * s
    const rz = -px * s + pz * c
    px = rx
    pz = rz
  }
  return {
    posOffset: new THREE.Vector3(
      px,
      preset.posOffset.y + effective.height,
      pz
    ),
    targetOffset: new THREE.Vector3(
      preset.targetOffset.x + hx,
      preset.targetOffset.y + effective.height * 0.5,
      preset.targetOffset.z
    ),
  }
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function pulseButton(button: HTMLButtonElement) {
  button.classList.remove('is-popping')
  void button.offsetWidth
  button.classList.add('is-popping')
}
