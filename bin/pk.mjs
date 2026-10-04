#!/usr/bin/env node
// pk, also installed as projectkeeper — the ProjectKeeper command (src/cli.ts says what it does). This file is plain
// JavaScript so that it runs wherever npm puts it: from a clone, after `npm link`, through `npm exec` / `npx`, or installed as a package — where Node will
// not strip types under node_modules by itself, and bin/strip-types.mjs does it for ProjectKeeper's own sources.
if (import.meta.url.includes('/node_modules/')) await import('./strip-types.mjs');
await import('../src/cli.ts');
