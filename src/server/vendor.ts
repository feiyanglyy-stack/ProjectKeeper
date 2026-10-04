/**
 * The node_modules the page's own scripts (cytoscape, dagre, cytoscape-dagre) are served from at `/vendor/`: the
 * package's own in a clone, the one above it when ProjectKeeper is installed as a package and npm put its dependencies
 * beside it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function vendorDir(appRoot: string): string {
  for (let dir = appRoot; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', 'cytoscape', 'package.json'))) return join(dir, 'node_modules');
    if (dirname(dir) === dir) return join(appRoot, 'node_modules');
  }
}
