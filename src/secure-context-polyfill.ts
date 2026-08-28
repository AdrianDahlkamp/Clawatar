/**
 * Polyfill: crypto.randomUUID requires a secure context (HTTPS or localhost).
 * When Clawatar is accessed via LAN IP (e.g. http://10.12.95.92:3000 from
 * another device), randomUUID is undefined. Fall back to a v4 UUID via
 * getRandomValues, which is available everywhere.
 */
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  (crypto as any).randomUUID = function (): string {
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
    // last resort
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }
}

export {}
