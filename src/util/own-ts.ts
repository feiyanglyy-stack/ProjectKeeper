/**
 * What a new Node thread or process needs to load ProjectKeeper's own TypeScript sources.
 *
 * In a clone: nothing — Node strips the types itself. Installed as a package the sources sit under node_modules, where
 * Node refuses to; bin/strip-types.mjs does it instead, and has to be loaded again in every worker thread and child
 * process that runs one of these sources (the file scan's and the ledger rebuild's workers, the code engine's child).
 */
const underNodeModules = import.meta.url.includes('/node_modules/');
const preload = ['--import', new URL('../../bin/strip-types.mjs', import.meta.url).href];

/** For a child process: flags to put before the script. */
export const OWN_TS_NODE_ARGS: readonly string[] = underNodeModules ? preload : [];

/** For `new Worker(…)`: options to spread in. Nothing in a clone, so a worker there starts exactly as it always did. */
export const OWN_TS_WORKER_OPTIONS: { readonly execArgv?: string[] } = underNodeModules ? { execArgv: [...preload] } : {};
