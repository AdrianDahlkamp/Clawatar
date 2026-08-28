/**
 * Unity pose loader UI — scans public/poses-unity/, lists poses in the debug
 * section, and plays them by converting the VRIK capture to VRM bone rotations
 * live in the browser.
 */
import { parseUnityAnim, convertPose, applyPose, storeRestPositions } from './unity-anim'
import { state } from './app-state'

let poseIndex: { name: string; path: string }[] = []

export async function initUnityPoses(): Promise<void> {
  const select = document.getElementById('unity-pose-select') as HTMLSelectElement | null
  const playBtn = document.getElementById('play-unity-pose-btn') as HTMLButtonElement | null
  if (!select || !playBtn) return

  try {
    const resp = await fetch('/poses-unity/index.json')
    if (!resp.ok) return
    poseIndex = await resp.json()
  } catch {
    return
  }
  if (poseIndex.length === 0) return

  for (const pose of poseIndex) {
    const opt = document.createElement('option')
    opt.value = pose.path
    opt.textContent = pose.name
    select.appendChild(opt)
  }

  playBtn.addEventListener('click', () => {
    const vrm = state.vrm
    if (!vrm) { console.warn('[unity-poses] No VRM loaded'); return }
    const path = select.value
    if (!path) return
    void playUnityPose(path, vrm)
  })
}

// suspend idle/animation system while a unity pose is showing (moved below initUnityPoses)

/** Freeze flag: while true, the idle/blinking/animation systems must not touch bones.
 *  Set for 10s after applying a unity pose. */
export function isUnityPoseHolding(): boolean {
  return performance.now() < poseHoldUntil
}
let poseHoldUntil = 0

export async function playUnityPose(path: string, vrm: NonNullable<typeof state.vrm>): Promise<void> {
  try {
    const resp = await fetch(path)
    if (!resp.ok) throw new Error(`fetch ${resp.status}`)
    const text = await resp.text()
    const parsed = parseUnityAnim(text)
    // cache rest positions now if the VRM-load hook missed them (race-safe)
    storeRestPositions(vrm)
    const pose = convertPose(parsed, vrm)

    // Freeze the animation system: kill all running actions so the idle loop
    // doesn't overwrite our pose every frame. Hold for 10s, then idle resumes.
    state.mixer?.stopAllAction()
    poseHoldUntil = performance.now() + 10000

    applyPose(vrm, pose)
    vrm.humanoid.update()
    console.log(`[unity-poses] Applied pose: ${parsed.name} (${pose.rotations.size} bones)`)
  } catch (e) {
    console.error('[unity-poses] Failed:', e)
  }
}