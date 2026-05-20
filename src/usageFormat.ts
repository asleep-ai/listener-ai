// Renderer-safe USD formatter. Lives in src/ (not src/services/) because
// src/services/usageTracker.ts pulls in fs + getDataPath() and isn't importable
// from the renderer. Keep this file dependency-free.

export type ZeroStyle = 'short' | 'long' | 'omit';

/**
 * Format a USD amount for display.
 *   - >=$0.01 → `$1.23` (2 decimals)
 *   - <$0.01  → `$0.0012` (4 decimals, so tiny per-call costs aren't all `$0.00`)
 *   - 0       → `$0` (short) / `$0.00` (long) / `''` (omit)
 */
export function formatUsd(usd: number, zero: ZeroStyle = 'short'): string {
  if (usd === 0) {
    return zero === 'omit' ? '' : zero === 'long' ? '$0.00' : '$0';
  }
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
