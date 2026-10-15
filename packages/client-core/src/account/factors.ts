// Wave web3.6 (flow 10): second factors. FactorsController lands in Task C3.
/** Per-feature synchronous checks for the web3.6 factor commands; Task C3 narrows the key type to its methods. */
export const FACTOR_VALIDATORS: Partial<Record<string, (c: Record<string, unknown>) => string | null>> = {};
