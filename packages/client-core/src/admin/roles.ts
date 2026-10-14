// Wave 2a (flow 09): roles, grants, channel overwrites and private channels. RolesController lands in Task C3.
/** Per-feature synchronous checks for the wave 2a commands; Task C3 narrows the key type to its methods. */
export const ROLES_VALIDATORS: Partial<Record<string, (c: Record<string, unknown>) => string | null>> = {};
