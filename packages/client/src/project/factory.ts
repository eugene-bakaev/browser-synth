// freshStep / freshTrack / freshProject now live in @fiddle/shared so both
// client and server can construct an identical default Project. This file is
// a thin re-export shim — new code should import directly from `@fiddle/shared`.
export { freshStep, freshTrack, freshProject } from '@fiddle/shared';
