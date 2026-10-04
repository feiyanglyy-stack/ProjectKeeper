/**
 * Worker-thread entry for `rebuildLedger`: the recompute runs off the main thread so the workbench
 * keeps answering while a large project's ledger is rebuilt (CKC-22 AC-16: no model involved).
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { Project } from '../model/types.ts';
import { rebuildLedgerInPlace, type RebuildOptions } from './rebuild.ts';

const data = workerData as { dbPath: string; project: Project; opts: RebuildOptions };
try {
  const stats = rebuildLedgerInPlace(data.dbPath, data.project, data.opts);
  parentPort!.postMessage({ ok: true, stats });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: (error as Error).message });
}
