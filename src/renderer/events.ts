// Shim — preserves the existing `../events` import path while the bus
// implementation moved into `./events/`. New code should import from
// `./events` (the directory) for typed agent helpers.
export * from './events/index';
