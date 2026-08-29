// ═══════════════════════════════════════════════════════════════
// Outfit Scheduler — Tageszeit-/Wochentag-abhängige VRM-Modelle
// Idee: Adrian, 29.08.2026 🌅
// Config: public/outfits.json — Slots mit Uhrzeit + Wochentagen,
//         optional Special-Dates (z.B. Hochzeit 👔)
// ═══════════════════════════════════════════════════════════════

export type OutfitDays = 'all' | 'weekdays' | 'weekends'

export interface OutfitSlot {
  id: string
  label: string
  /** Start-Stunde (inklusiv), lokale Zeit */
  start: number
  /** End-Stunde (exklusiv). Kleinergleich start => über Mitternacht (z.B. 22 → 5) */
  end: number
  /** 'weekdays' = Mo-Fr, 'weekends' = Sa/So, 'all' = jeden Tag (default) */
  days?: OutfitDays
  /** Model-URL relativ zur Seite, z.B. "./models/shiho-morning.vrm" */
  model: string
}

export interface SpecialDate {
  /** ISO-Datum lokal, z.B. "2026-09-18" */
  date: string
  outfitId: string
}

export interface OutfitsConfig {
  enabled: boolean
  /** Prüfintervall in Sekunden */
  checkIntervalSec: number
  outfits: OutfitSlot[]
  specialDates?: SpecialDate[]
}

const DEFAULT_CHECK_INTERVAL_SEC = 60
const MISSING_MODEL_TTL_MS = 10 * 60 * 1000 // fehlende Modelle 10 min nicht erneut probieren

let config: OutfitsConfig | null = null
let watcherTimer: number | null = null
let currentOutfitId: string | null = null
let manualOverrideId: string | null = null
let missingModels = new Map<string, number>() // model URL → timestamp
let lastAppliedModelURL: string | null = null
let switching = false

// ── Config ──────────────────────────────────────────────────────

export async function loadOutfitsConfig(): Promise<OutfitsConfig | null> {
  if (config) return config
  try {
    const resp = await fetch('./outfits.json', { cache: 'no-store' })
    if (!resp.ok) return null
    const raw = await resp.json()
    config = normalizeConfig(raw)
  } catch {
    config = null
  }
  return config
}

function normalizeConfig(raw: any): OutfitsConfig | null {
  if (!raw || !Array.isArray(raw.outfits) || raw.outfits.length === 0) return null
  const outfits: OutfitSlot[] = raw.outfits
    .filter((o: any) => typeof o?.id === 'string' && typeof o?.model === 'string' && Number.isFinite(o?.start) && Number.isFinite(o?.end))
    .map((o: any) => ({
      id: String(o.id),
      label: typeof o.label === 'string' ? o.label : String(o.id),
      start: ((o.start % 24) + 24) % 24,
      end: ((o.end % 24) + 24) % 24,
      days: (['all', 'weekdays', 'weekends'] as const).includes(o.days) ? o.days : 'all',
      model: String(o.model),
    }))
  if (outfits.length === 0) return null
  const specialDates: SpecialDate[] = Array.isArray(raw.specialDates)
    ? raw.specialDates.filter((s: any) => typeof s?.date === 'string' && typeof s?.outfitId === 'string')
        .map((s: any) => ({ date: String(s.date), outfitId: String(s.outfitId) }))
    : []
  return {
    enabled: raw.enabled !== false,
    checkIntervalSec: Number.isFinite(raw.checkIntervalSec) && raw.checkIntervalSec >= 15 ? raw.checkIntervalSec : DEFAULT_CHECK_INTERVAL_SEC,
    outfits,
    specialDates: specialDates.length > 0 ? specialDates : undefined,
  }
}

// ── Slot-Auflösung ─────────────────────────────────────────────

function matchesDays(days: OutfitDays, now: Date): boolean {
  if (days === 'all') return true
  const d = now.getDay() // 0 = So, 6 = Sa
  const isWeekend = d === 0 || d === 6
  return days === 'weekends' ? isWeekend : !isWeekend
}

/** Läuft ein Slot zum Zeitpunkt now? (verarbeitet auch über-Mitternacht-Slots) */
export function isSlotActive(slot: OutfitSlot, now: Date): boolean {
  if (!matchesDays(slot.days ?? 'all', now)) return false
  const h = now.getHours()
  if (slot.start === slot.end) return true
  if (slot.start < slot.end) return h >= slot.start && h < slot.end
  // über Mitternacht: z.B. 22 → 5
  return h >= slot.start || h < slot.end
}

export async function resolveCurrentOutfit(now: Date = new Date()): Promise<OutfitSlot | null> {
  const cfg = await loadOutfitsConfig()
  if (!cfg || !cfg.enabled) return null

  if (manualOverrideId) {
    const overrideSlot = cfg.outfits.find((o) => o.id === manualOverrideId)
    if (overrideSlot) return overrideSlot
    // Override zeigt auf nicht existierendes Outfit → verwerfen
    manualOverrideId = null
  }

  // Special-Dates gewinnen immer (außer manuellem Override)
  if (cfg.specialDates) {
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const special = cfg.specialDates.find((s) => s.date === iso)
    if (special) {
      const slot = cfg.outfits.find((o) => o.id === special.outfitId)
      if (slot) return slot
    }
  }

  return cfg.outfits.find((o) => isSlotActive(o, now)) ?? null
}

// ── Verfügbarkeits-Check ────────────────────────────────────────

async function isModelAvailable(url: string): Promise<boolean> {
  const missingAt = missingModels.get(url)
  if (missingAt && Date.now() - missingAt < MISSING_MODEL_TTL_MS) return false
  try {
    const resp = await fetch(url, { method: 'HEAD' })
    if (resp.ok) return true
    // Manche Server verweigern HEAD → GET-Range probieren
    const getResp = await fetch(url, { headers: { Range: 'bytes=0-1023' } })
    if (getResp.ok) return true
  } catch {}
  missingModels.set(url, Date.now())
  return false
}

// ── Modell-Swap ─────────────────────────────────────────────────

export interface OutfitSwapDeps {
  loadVRM: (url: string) => Promise<any>
  playBaseIdle: (...args: any[]) => Promise<any>
  warmActions?: (preload: (id: string) => Promise<unknown>) => void
}

let deps: OutfitSwapDeps | null = null

export function initOutfitScheduler(swapDeps: OutfitSwapDeps): void {
  deps = swapDeps
}

async function applySlot(slot: OutfitSlot): Promise<void> {
  if (!deps || switching) return
  switching = true
  try {
    const available = await isModelAvailable(slot.model)
    if (!available) {
      console.warn(`[outfit-scheduler] Model für "${slot.id}" (${slot.model}) nicht gefunden — behalte aktuelles Modell`)
      currentOutfitId = slot.id // nicht jede Minute neu probieren (TTL regelt)
      return
    }
    if (lastAppliedModelURL === slot.model) {
      currentOutfitId = slot.id
      return
    }
    console.info(`[outfit-scheduler] Outfit-Wechsel → ${slot.id} (${slot.label})`)
    const vrm = await deps.loadVRM(slot.model)
    vrm?.scene?.traverse?.((child: any) => {
      if (child?.isMesh) child.castShadow = true
    })
    lastAppliedModelURL = slot.model
    currentOutfitId = slot.id
    await deps.playBaseIdle().catch(() => {})
  } catch (e) {
    console.warn('[outfit-scheduler] Swap fehlgeschlagen:', e)
  } finally {
    switching = false
  }
}

// ── Watcher ─────────────────────────────────────────────────────

/** Prüft einmalig, ob ein Update fällig ist (aufgerufen vom Timer) */
async function checkOnce(): Promise<void> {
  const slot = await resolveCurrentOutfit()
  if (!slot) return
  if (slot.id === currentOutfitId && lastAppliedModelURL === slot.model) return
  await applySlot(slot)
}

/** Startet die periodische Prüfung. Early-Boot-Auswahl passiert in resolveAutoLoadModelURL(). */
export function startOutfitWatcher(): void {
  if (watcherTimer !== null) return
  const cfg = config
  const intervalMs = (cfg?.checkIntervalSec ?? DEFAULT_CHECK_INTERVAL_SEC) * 1000
  watcherTimer = window.setInterval(() => {
    void checkOnce()
  }, Math.max(intervalMs, 15_000))
  console.info(`[outfit-scheduler] Watcher aktiv (alle ${Math.round(intervalMs / 1000)}s)`)
}

// ── Auto-Load-Integration ───────────────────────────────────────

/**
 * Liefert die Model-URL für den passenden Slot zum Aufruf-Zeitpunkt.
 * Fallback: null (Aufrufer nutzt sein Default).
 */
export async function resolveAutoLoadOutfitURL(): Promise<string | null> {
  const slot = await resolveCurrentOutfit()
  if (!slot) return null
  const available = await isModelAvailable(slot.model)
  if (!available) {
    console.warn(`[outfit-scheduler] Boot: "${slot.id}" (${slot.model}) fehlt — nutze Default-Modell`)
    // Slot als current markieren, damit applySlot später nicht gleich reloadet
    currentOutfitId = slot.id
    lastAppliedModelURL = null
    return null
  }
  currentOutfitId = slot.id
  lastAppliedModelURL = slot.model
  return slot.model
}

// ── Manual Override (Debug / Special-Layer) ─────────────────────

/**
 * Manuelles Outfit erzwingen: window.__setOutfit('evening') | window.__setOutfit(null)
 * URL-Param beim Boot: ?outfit=evening
 */
export function setManualOutfit(outfitId: string | null): void {
  manualOverrideId = outfitId
  if (!outfitId) {
    // Zurück zum automatischen Slot
    void checkOnce()
    return
  }
  void (async () => {
    const slot = await resolveCurrentOutfit()
    if (slot) await applySlot(slot)
  })()
}

export function getCurrentOutfitId(): string | null {
  return currentOutfitId ?? manualOverrideId
}

// ?outfit= Param beim Boot auswerten
if (typeof window !== 'undefined') {
  try {
    const param = new URLSearchParams(window.location.search).get('outfit')
    if (param) manualOverrideId = param
    ;(window as any).__setOutfit = setManualOutfit
    ;(window as any).__getOutfit = getCurrentOutfitId
  } catch {}
}