'use strict';
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { fail } = require('./policy.cjs');
// Retain keyed comparison hashes, never plaintext SSH passwords/passphrases.
// A rolling fingerprint locates candidates cheaply; HMAC confirms exact matches.
class SensitiveValues {
  constructor() { this.key = randomBytes(32); this.base = 65599; this.groups = new Map(); this.revision = 0; }
  digest(value) { return createHmac('sha256', this.key).update(value).digest(); }
  fingerprint(value) { let h = 0; for (let i = 0; i < value.length; i++) h = (Math.imul(h, this.base) + value.charCodeAt(i)) >>> 0; return h; }
  add(value) {
    if (typeof value !== 'string' || !value) return false;
    const variants = new Set([value, JSON.stringify(value).slice(1, -1)]);
    try { const encoded = encodeURIComponent(value); variants.add(encoded); variants.add(encoded.replace(/%[A-F0-9]{2}/g, s => s.toLowerCase())); variants.add(encoded.replace(/%20/g, '+')); } catch {}
    let changed = false;
    for (const v of variants) {
      let group = this.groups.get(v.length);
      if (!group) { let power = 1; for (let i = 1; i < v.length; i++) power = Math.imul(power, this.base) >>> 0; group = { power, hashes: new Map() }; this.groups.set(v.length, group); }
      const hash = this.fingerprint(v), digest = this.digest(v), existing = group.hashes.get(hash) || [];
      if (existing.some(d => timingSafeEqual(d, digest))) { digest.fill(0); continue; }
      existing.push(digest); group.hashes.set(hash, existing); changed = true;
    }
    if (changed) this.revision++; return changed;
  }
  redact(input) {
    const spans = []; let work = 0;
    for (const [length, group] of this.groups) {
      if (length > input.length) continue;
      work += input.length - length + 1; if (work > 16000000) fail('E-AI-MASK-SIZE');
      let hash = this.fingerprint(input.slice(0, length));
      for (let start = 0; start <= input.length - length; start++) {
        const candidates = group.hashes.get(hash);
        if (candidates) { const digest = this.digest(input.slice(start, start + length)); const match = candidates.some(d => timingSafeEqual(d, digest)); digest.fill(0); if (match) spans.push([start, start + length]); }
        if (start + length < input.length) hash = (Math.imul((hash - Math.imul(input.charCodeAt(start), group.power)) >>> 0, this.base) + input.charCodeAt(start + length)) >>> 0;
      }
    }
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]); const merged = [];
    for (const span of spans) { const last = merged.at(-1); if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]); }
    let text = '', end = 0; for (const [start, next] of merged) { text += input.slice(end, start) + '****'; end = next; }
    return { text: text + input.slice(end), redactions: merged.length };
  }
  dispose() { this.key.fill(0); for (const group of this.groups.values()) for (const values of group.hashes.values()) for (const value of values) value.fill(0); this.groups.clear(); }
}
module.exports = { SensitiveValues };
