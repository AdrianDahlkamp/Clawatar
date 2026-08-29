/**
 * Streaming audio player for voice/chat mode.
 *
 * Uses MediaSource Extensions to play MP3 audio chunks as they arrive
 * from the WS server, achieving near-zero buffering delay.
 * Falls back to Blob-based playback if MSE is unavailable (Safari).
 *
 * Exposes an AnalyserNode for real-time lip-sync in lip-sync.ts.
 */

import { setStreamingAnalyser } from './lip-sync'

const MP3_MIME = 'audio/mpeg'

class StreamingAudioPlayer {
  private mediaSource: MediaSource | null = null
  private sourceBuffer: SourceBuffer | null = null
  private audio: HTMLAudioElement | null = null
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private elSrc: MediaElementAudioSourceNode | null = null

  private queue: ArrayBuffer[] = []
  private fallbackChunks: ArrayBuffer[] = []
  private streamEnded = false
  private _playing = false
  private useMSE: boolean

  // ── PCM-Modus (29.08.2026): qwen-tts.cpp liefert s16le-24kHz-Chunks als base64 ──
  private pcmCtx: AudioContext | null = null
  private pcmQueue: Float32Array[] = []
  private pcmReadOffset = 0
  private pcmCurrent: AudioBufferSourceNode | null = null
  private pcmNextStartTime = 0

  constructor() {
    this.useMSE =
      typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported(MP3_MIME)
  }

  /* ───── public API ───── */

  async startStream(): Promise<void> {
    this.cleanup()
    this.streamEnded = false
    this._playing = true
    this.queue = []
    this.fallbackChunks = []
    this.pcmQueue = []
    this.pcmReadOffset = 0
    this.pcmNextStartTime = 0
    this.pcmPendingChunks = []

    this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') await this.ctx.resume()

    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.smoothingTimeConstant = 0.5

    if (this.useMSE) {
      await this.initMSE()
    }

    setStreamingAnalyser(true, this.analyser)
  }

  feedChunk(base64: string, sampleRate?: number): void {
    // PCM-Erkennung: audio_chunk mit sampleRate (rohes s16le-PCM, kein RIFF/MP3).
    // Erster PCM-Chunk aktiviert den Modus nachträglich → ctx wurde in startStream
    // ohnehin schon erzeugt, die WebAudio-Queue übernimmt ab da.
    const buf = b64ToBuffer(base64)
    if (sampleRate === 24000 || this.pcmModeArmed) {
      this.pcmModeArmed = true
      // WICHTIG: ensurePcmCtx ist async, aber feedPcm muss garantiert danach laufen.
      // Wenn ctx schon existiert (Normalfall nach startStream), ist ensurePcmCtx synchron.
      // Für den ersten Chunk: Puffer im pcmQueueBuffer, dann flushen.
      this.pcmPendingChunks.push(buf)
      void this.ensurePcmCtx().then(() => {
        while (this.pcmPendingChunks.length > 0) {
          this.feedPcm(this.pcmPendingChunks.shift()!)
        }
      })
      return
    }
    if (this.useMSE && this.sourceBuffer) {
      this.queue.push(buf)
      this.flush()
    } else {
      this.fallbackChunks.push(buf)
    }
  }

  /** Aktiviert den PCM-Modus für den NÄCHSTEN Stream (vom Server via sampleRate signalisiert). */
  markPcmMode(): void {
    this.pcmModeArmed = true
  }

  private pcmModeArmed = false
  private pcmPendingChunks: ArrayBuffer[] = []

  private async ensurePcmCtx(): Promise<void> {
    if (!this.pcmCtx) {
      this.pcmCtx = this.ctx ?? new AudioContext()
      if (this.pcmCtx.state === 'suspended') await this.pcmCtx.resume()
    }
  }

  private feedPcm(buf: ArrayBuffer): void {
    // s16le → f32 [-1, 1]
    const s16 = new Int16Array(buf)
    const f32 = new Float32Array(s16.length)
    for (let i = 0; i < s16.length; i++) f32[i] = s16[i] / 32768
    this.pcmQueue.push(f32 as Float32Array<ArrayBuffer>)
    void this.trySchedulePcm()
  }

  private scheduledSeconds = 0

  private async trySchedulePcm(): Promise<void> {
    const ctx = this.pcmCtx
    if (!ctx || !this.analyser) return
    await this.ensurePcmCtx()
    // Pre-Roll: bis 800ms voraus planen (war 300ms → zu klein, causing gaps)
    const PRE_ROLL = 0.8
    while (this.pcmQueue.length > 0) {
      const now = ctx.currentTime
      // Wenn wir hinterherhinken: nahtlos an currentTime anschließen (kein Gap!)
      if (this.pcmNextStartTime < now) {
        this.pcmNextStartTime = now
      }
      if (this.pcmNextStartTime - now > PRE_ROLL) break // genug gepuffert
      const f32 = this.pcmQueue.shift()!
      const audioBuf = ctx.createBuffer(1, f32.length, 24000)
      audioBuf.copyToChannel(f32 as unknown as Float32Array<ArrayBuffer>, 0)
      const srcNode = ctx.createBufferSource()
      srcNode.buffer = audioBuf
      srcNode.connect(this.analyser!)
      srcNode.start(this.pcmNextStartTime)
      this.pcmNextStartTime += audioBuf.duration
      srcNode.onended = () => { void this.checkPcmDrained() }
      this.pcmCurrent = srcNode
      this.scheduledSeconds += audioBuf.duration
    }
  }

  private async checkPcmDrained(): Promise<void> {
    if (
      this.streamEnded &&
      this.pcmQueue.length === 0 &&
      this.pcmCtx &&
      this.pcmNextStartTime - this.pcmCtx.currentTime <= 0.02
    ) {
      // alles ausgespielt → endStream-Resolver feuern
      for (const r of this.pcmEndedResolvers.splice(0)) r()
    }
  }

  private pcmEndedResolvers: Array<() => void> = []

  /** Signal that no more chunks are coming. Resolves when audio finishes. */
  endStream(): Promise<void> {
    this.streamEnded = true

    // PCM-Modus: warten bis Queue + scheduling abgelaufen sind
    if (this.pcmCtx && !this.useMSE) {
      return new Promise<void>((resolve) => {
        // Sofort prüfen (kurze Streams können schon fertig sein)
        void this.checkPcmDrained()
        this.pcmEndedResolvers.push(() => { this.finish(); resolve() })
        // Safety-Timeout
        setTimeout(() => { this.finish(); resolve() }, 120_000)
      })
    }

    if (this.useMSE) {
      return new Promise<void>((resolve) => {
        this.tryEndOfStream()

        if (!this.audio) { this.finish(); resolve(); return }

        const done = () => { this.finish(); resolve() }

        this.audio.addEventListener('ended', done, { once: true })

        // safety poll (ended event can be missed when duration is tiny)
        const iv = setInterval(() => {
          if (!this._playing) { clearInterval(iv); return }
          if (this.audio && (this.audio.ended || this.audio.paused)) {
            clearInterval(iv)
            done()
          }
        }, 200)
        setTimeout(() => { clearInterval(iv); done() }, 60_000)
      })
    }

    // fallback path — play accumulated blob
    return this.playFallback().then(() => this.finish())
  }

  stopStream(): void {
    this.streamEnded = true
    this.queue = []
    this.fallbackChunks = []
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load() }
    this.finish()
    this.cleanup()
  }

  isPlaying(): boolean { return this._playing }

  /* ───── MSE setup ───── */

  private async initMSE(): Promise<void> {
    this.mediaSource = new MediaSource()
    this.audio = new Audio()
    this.audio.src = URL.createObjectURL(this.mediaSource)

    await new Promise<void>((resolve, reject) => {
      this.mediaSource!.addEventListener('sourceopen', () => {
        try {
          this.sourceBuffer = this.mediaSource!.addSourceBuffer(MP3_MIME)
          this.sourceBuffer.addEventListener('updateend', () => {
            this.flush()
            this.tryEndOfStream()
          })
          resolve()
        } catch (e) { reject(e) }
      })
      setTimeout(() => reject(new Error('MSE open timeout')), 5000)
    })

    this.elSrc = this.ctx!.createMediaElementSource(this.audio)
    this.elSrc.connect(this.analyser!)
    this.analyser!.connect(this.ctx!.destination)

    this.audio.play().catch((e) => console.warn('[streaming-audio] play():', e))
  }

  /* ───── chunk queue ───── */

  private flush(): void {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.queue.length === 0) return
    const chunk = this.queue.shift()!
    try {
      this.sourceBuffer.appendBuffer(chunk)
    } catch (e: any) {
      if (e.name === 'QuotaExceededError') {
        const b = this.sourceBuffer.buffered
        if (b.length > 0) try { this.sourceBuffer.remove(0, b.start(b.length - 1)) } catch {}
        this.queue.unshift(chunk)
      } else {
        console.error('[streaming-audio] appendBuffer:', e)
      }
    }
  }

  private tryEndOfStream(): void {
    if (
      this.streamEnded &&
      this.queue.length === 0 &&
      this.sourceBuffer && !this.sourceBuffer.updating &&
      this.mediaSource?.readyState === 'open'
    ) {
      try { this.mediaSource.endOfStream() } catch {}
    }
  }

  /* ───── fallback (no MSE) ───── */

  private async playFallback(): Promise<void> {
    if (this.fallbackChunks.length === 0) return
    const total = this.fallbackChunks.reduce((s, b) => s + b.byteLength, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const b of this.fallbackChunks) { merged.set(new Uint8Array(b), off); off += b.byteLength }

    const url = URL.createObjectURL(new Blob([merged], { type: 'audio/mpeg' }))
    this.audio = new Audio(url)
    this.elSrc = this.ctx!.createMediaElementSource(this.audio)
    this.elSrc.connect(this.analyser!)
    this.analyser!.connect(this.ctx!.destination)

    return new Promise<void>((resolve) => {
      this.audio!.addEventListener('ended', () => { URL.revokeObjectURL(url); resolve() }, { once: true })
      this.audio!.play().catch(() => resolve())
    })
  }

  /* ───── lifecycle ───── */

  private finish(): void {
    this._playing = false
    setStreamingAnalyser(false, null)
  }

  private cleanup(): void {
    if (this.audio) {
      this.audio.pause()
      if (this.audio.src?.startsWith('blob:')) URL.revokeObjectURL(this.audio.src)
    }
    this.audio = null
    this.elSrc = null
    this.sourceBuffer = null
    this.mediaSource = null
    // PCM-Zustand zurücksetzen (nicht pcmCtx closen: kann identisch mit this.ctx sein)
    try { this.pcmCurrent?.stop() } catch {}
    this.pcmCurrent = null
    this.pcmQueue = []
    this.pcmReadOffset = 0
    this.pcmNextStartTime = 0
    this.pcmEndedResolvers = []
    this.pcmModeArmed = false
    this.pcmPendingChunks = []
    this.scheduledSeconds = 0
    if (this.analyser) try { this.analyser.disconnect() } catch {}
    this.analyser = null
    if (this.ctx) try { this.ctx.close() } catch {}
    this.ctx = null
    this.queue = []
    this.fallbackChunks = []
    this._playing = false
  }
}

/* ───── helpers ───── */

function b64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/** Singleton — import and use directly */
export const streamingPlayer = new StreamingAudioPlayer()
