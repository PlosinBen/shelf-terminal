// Agent-server logger facade. Two separate entry points so a call site's import
// declares where its logs go:
//   wireLogger — to main over the wire (normal); .channel(name) → named file at main
//   rawLogger  — stderr only (wire-dead / pre-boot last resort)
// Coexists with the legacy serverLog (untouched); call sites migrate incrementally.

export { wireLogger } from './wire';
export { rawLogger } from './raw';
export { LogTag, setWireSink } from './core';
export type { Leveled } from './wire';
export type { WireLogMessage } from './core';
