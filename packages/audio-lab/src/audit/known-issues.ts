// Expected-failure register: check id -> one-line reason. A failing check
// listed here reports KNOWN (suite stays green); a PASSING check listed here
// reports STALE_KNOWN so dead entries get removed. Keep reasons specific.
export const KNOWN_ISSUES: Record<string, string> = {};
