// After `npm ci` / `npm install`: apply ProjectKeeper's patch to the installed pi-ai (patches/README.md). Plain
// JavaScript for the same reason as bin/pk.mjs: installed as a package, the script it runs sits under node_modules.
if (import.meta.url.includes('/node_modules/')) await import('./strip-types.mjs');
const { applyPiStreamingPatch, label } = await import('../scripts/apply-pi-streaming-patch.ts');
console.log(`${label}:`, await applyPiStreamingPatch());
