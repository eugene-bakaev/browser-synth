// Wire-format protocol version. Distinct from PROJECT_SCHEMA_VERSION:
// PROTOCOL_VERSION covers the envelope + message shapes (hello, welcome, set,
// snapshot, etc.); PROJECT_SCHEMA_VERSION covers the Project payload itself.
// Bump only on breaking wire changes.
export const PROTOCOL_VERSION = 1 as const;
