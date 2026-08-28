import { loadVRM } from './vrm-loader'
import { loadAndPlay } from './animation'
import { setExpression, getExpressionOverrides } from './expressions'
import { setTransparentBackground } from './scene'
import { state } from './app-state'
import { setAutoBlinkEnabled } from './blink'
import { requestAction, onStateChange, idleConfig } from './action-state-machine'
import { setCrossfadeScale, crossfadeScale } from './animation'
import { loadSceneFromJSON, unloadScene, isActive } from './scene-system/index'
import { broadcastSyncCommand } from './sync-bridge'

// Actions loaded from catalog
let ALL_ACTIONS: string[] = []

async function loadCatalog() {
  try {
    const resp = await fetch('./animations/catalog.json')
    if (resp.ok) {
      const catalog = await resp.json()
      ALL_ACTIONS = catalog.animations.map((a: any) => a.id)
    }
  } catch (e) {
    console.warn('Failed to load animation catalog:', e)
  }
  if (ALL_ACTIONS.length === 0) {
    // Fallback
    ALL_ACTIONS = ['119_Idle', '161_Waving', '86_Talking']
  }
}

const EXPRESSIONS = ['happy', 'angry', 'sad', 'surprised', 'relaxed', 'neutral']

export async function initUI() {
  // Expose crossfade scale for console tuning: window.setCrossfadeScale(2.0)
  ;(window as any).setCrossfadeScale = setCrossfadeScale
  ;(window as any).getCrossfadeScale = () => crossfadeScale

  await loadCatalog()
  // State indicator
  const stateEl = document.getElementById('state-indicator')
  if (stateEl) {
    onStateChange((s) => {
      stateEl.textContent = s.charAt(0).toUpperCase() + s.slice(1)
      stateEl.className = `state-badge state-${s}`
    })
  }

  // Load model button
  document.getElementById('load-model-btn')?.addEventListener('click', () => {
    const input = document.getElementById('model-url') as HTMLInputElement
    if (input.value) loadVRM(input.value).catch(console.error)
  })

  // Action search/select
  const actionSelect = document.getElementById('action-select') as HTMLSelectElement
  const actionSearch = document.getElementById('action-search') as HTMLInputElement
  if (actionSelect) {
    populateActions(actionSelect, ALL_ACTIONS)
  }
  if (actionSearch && actionSelect) {
    actionSearch.addEventListener('input', () => {
      const q = actionSearch.value.toLowerCase()
      const filtered = ALL_ACTIONS.filter(a => a.toLowerCase().includes(q))
      populateActions(actionSelect, filtered)
    })
  }
  document.getElementById('play-action-btn')?.addEventListener('click', () => {
    if (actionSelect?.value) requestAction(actionSelect.value).catch(console.error)
  })

  // Expression sliders
  const exprContainer = document.getElementById('expression-sliders')
  if (exprContainer) {
    for (const expr of EXPRESSIONS.filter(e => e !== 'neutral')) {
      const row = document.createElement('div')
      row.className = 'expr-row'
      row.innerHTML = `<label>${expr}</label><input type="range" min="0" max="100" value="0" data-expr-slider="${expr}"><span class="expr-val">0</span>`
      exprContainer.appendChild(row)
      const slider = row.querySelector('input') as HTMLInputElement
      const valSpan = row.querySelector('.expr-val') as HTMLSpanElement
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value) / 100
        valSpan.textContent = slider.value
        setExpression(expr, v, 3.0, { sync: true })
      })
    }
  }

  // Sync expression sliders with programmatic changes
  setInterval(() => {
    const overrides = getExpressionOverrides()
    for (const expr of EXPRESSIONS.filter(e => e !== 'neutral')) {
      const slider = document.querySelector(`[data-expr-slider="${expr}"]`) as HTMLInputElement
      const valSpan = slider?.parentElement?.querySelector('.expr-val') as HTMLSpanElement
      if (slider && valSpan) {
        const currentVal = Math.round((overrides.get(expr) ?? 0) * 100)
        if (parseInt(slider.value) !== currentVal) {
          slider.value = String(currentVal)
          valSpan.textContent = String(currentVal)
        }
      }
    }
  }, 100)

  // Idle settings
  setupNumberInput('idle-interval', idleConfig, 'idleActionInterval')
  setupNumberInput('idle-chance', idleConfig, 'idleActionChance')
  setupNumberInput('idle-min-hold', idleConfig, 'idleMinHoldSeconds')
  setupNumberInput('idle-max-hold', idleConfig, 'idleMaxHoldSeconds')

  // Toggles
  document.getElementById('auto-blink')?.addEventListener('change', (e) => {
    const enabled = (e.target as HTMLInputElement).checked
    setAutoBlinkEnabled(enabled)
  })
  document.getElementById('mouse-look')?.addEventListener('change', (e) => {
    state.mouseLookEnabled = (e.target as HTMLInputElement).checked
  })
  document.getElementById('transparent-bg')?.addEventListener('change', (e) => {
    setTransparentBackground((e.target as HTMLInputElement).checked)
  })

  // Scene selector
  const sceneSelect = document.getElementById('scene-select') as HTMLSelectElement | null
  if (sceneSelect) {
    sceneSelect.addEventListener('change', () => {
      const val = sceneSelect.value
      if (!val) {
        // "None" selected — unload scene, restore flat background
        if (isActive()) unloadScene()
      } else {
        loadSceneFromJSON(`scenes/${val}.json`).catch(e => {
          console.error('Scene load failed:', e)
          sceneSelect.value = ''
        })
      }
    })
  }

  // 3D Stage (Room GLB) selector
  const roomSelect = document.getElementById('room-select') as HTMLSelectElement | null
  if (roomSelect) {
    console.log('[ui] Room selector found, attaching handler')
    roomSelect.addEventListener('change', async () => {
      const val = roomSelect.value
      console.log('[ui] Room selected:', val || '(none)')
      if (!val) {
        // "None" — unload room, restore default
        try {
          const { unloadScene } = await import('./scene-system')
          unloadScene()
          broadcastSyncCommand({ type: 'set_scene', room: '' })
          console.log('[ui] Scene unloaded')
        } catch (e) {
          console.error('[ui] Unload failed:', e)
        }
      } else {
        try {
          console.log('[ui] Loading room GLB:', val)
          const { loadRoomGLB } = await import('./scene-system')
          await loadRoomGLB(val)
          broadcastSyncCommand({ type: 'set_scene', room: val })
          console.log('[ui] Room loaded OK:', val)
        } catch (e) {
          console.error('[ui] Room load FAILED:', e)
          roomSelect.value = ''
          alert('Scene load failed: ' + (e as Error).message)
        }
      }
    })
  } else {
    console.warn('[ui] room-select element not found!')
  }

  // Room rotation — spin the room around the avatar (who stands at origin)
  const ROT_KEY = 'clawatar-room-rotation'
  let rotationTimer: number | undefined

  const applyRotation = (deg: number, sync: boolean) => {
    import('./scene-system').then(({ setRoomRotation }) => {
      setRoomRotation(deg * Math.PI / 180)
      if (sync) broadcastSyncCommand({ type: 'set_room_rotation', radians: deg * Math.PI / 180 })
    })
  }

  const rotSection = document.getElementById('room-rotation-section')
  if (rotSection) {
    const slider = document.getElementById('room-rotation') as HTMLInputElement | null
    const valueLabel = document.getElementById('room-rotation-value')

    // Restore last rotation for this session (room loads reset it)
    const savedDeg = Number(localStorage.getItem(ROT_KEY) ?? '0')
    if (slider) slider.value = String(((savedDeg % 360) + 360) % 360)
    if (valueLabel) valueLabel.textContent = `${Math.round(((savedDeg % 360) + 360) % 360)}°`

    const onSliderInput = () => {
      if (!slider) return
      const deg = Number(slider.value)
      if (valueLabel) valueLabel.textContent = `${Math.round(deg)}°`
      localStorage.setItem(ROT_KEY, String(deg))
      // Throttle sync while dragging — apply locally every frame, sync at rest
      window.clearTimeout(rotationTimer)
      applyRotation(deg, false)
      rotationTimer = window.setTimeout(() => applyRotation(deg, true), 250)
    }
    slider?.addEventListener('input', onSliderInput)

    rotSection.querySelectorAll<HTMLElement>('[data-rot-nudge]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!slider) return
        const step = Number(btn.dataset.rotNudge ?? '15')
        const next = (Number(slider.value) + step + 360) % 360
        slider.value = String(next)
        onSliderInput()
      })
    })
  }

  // Collapsible sections
  document.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', () => {
      const section = header.parentElement!
      section.classList.toggle('collapsed')
    })
  })

  // Collapse-all button — hides ALL menu sections at once (panel shrinks to
  // just the "Shiho" title + Idle badge + button)
  const collapseAllBtn = document.getElementById('collapse-all-btn')
  const sectionsContainer = document.getElementById('controls-sections')
  if (collapseAllBtn) {
    const applyControlsHidden = (hidden: boolean) => {
      if (sectionsContainer) sectionsContainer.style.display = hidden ? 'none' : ''
      collapseAllBtn.textContent = hidden ? '▼' : '▲'
    }
    collapseAllBtn.addEventListener('click', () => {
      applyControlsHidden(sectionsContainer?.style.display !== 'none')
    })
    // Start collapsed — clean look, open on demand
    applyControlsHidden(true)
  }

  // Drag and drop
  const overlay = document.getElementById('drop-overlay')!
  const body = document.body
  body.addEventListener('dragover', (e) => { e.preventDefault(); overlay.classList.add('active') })
  body.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) overlay.classList.remove('active')
  })
  body.addEventListener('drop', async (e) => {
    e.preventDefault()
    overlay.classList.remove('active')
    const file = e.dataTransfer?.files[0]
    if (!file) return
    if (file.name.endsWith('.vrm')) {
      await loadVRM(file).catch(console.error)
    } else if (file.name.endsWith('.vrma')) {
      await loadAndPlay(URL.createObjectURL(file)).catch(console.error)
    }
  })
}

function populateActions(select: HTMLSelectElement, actions: string[]) {
  select.innerHTML = actions.map(a => `<option value="${a}">${a.replace(/_/g, ' ')}</option>`).join('')
}

function setupNumberInput(id: string, obj: any, key: string) {
  const el = document.getElementById(id) as HTMLInputElement
  if (!el) return
  el.value = String(obj[key])
  el.addEventListener('change', () => {
    obj[key] = parseFloat(el.value)
  })
}
