/**
 * Worker-thread entry for `scanFilesAsync`: reads every file in scope off the main thread so the
 * workbench keeps answering while a large project is taken in.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { ScopeItem } from '../model/types.ts';
import { scanFiles } from './files.ts';

const data = workerData as { projectId: string; scope: readonly ScopeItem[] };
parentPort!.postMessage(scanFiles(data.projectId, data.scope));
