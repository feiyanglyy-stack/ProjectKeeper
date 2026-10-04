import { registerHooks } from 'node:module';
import { files } from '../patches/pi-ai-0.87.1.ts';
import { originalSource } from './apply-pi-streaming-patch.ts';

// Replay upstream in memory in this process only; never overwrite installed dependencies.
if (process.argv.includes('--baseline')) {
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const patch = files.find((p) => url.endsWith('/@earendil-works/pi-ai/' + p.path));
    return patch && result.source ? { ...result, source: originalSource(String(result.source), patch) } : result;
  } });
}
const { measureToolStream, syntheticArguments } = await import('../src/keeper/testing/streaming-arguments.ts');

if (process.argv.includes('--consistency')) {
  const inputs = JSON.parse(process.argv.at(-1)!) as string[];
  const result = await measureToolStream(inputs, 20);
  console.log(JSON.stringify({ wire: result.wire, ended: result.ended }));
} else {
  // Optional byte lengths; defaults include a warmup followed by the four requested scales.
  await measureToolStream([syntheticArguments(1000)]);
  const sizes = process.argv.slice(2).filter((s) => !s.startsWith('--')).map(Number);
  for (const bytes of sizes.length ? sizes : [25000, 50000, 100000, 200000]) {
    const result = await measureToolStream([syntheticArguments(bytes)]);
    console.log(JSON.stringify({ bytes, chunkSize: 20, deltas: result.deltas, elapsedMs: +result.elapsedMs.toFixed(1), maxDelayMs: +result.maxDelayMs.toFixed(1) }));
  }
}
