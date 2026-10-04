// The card's material, lent to the graph's objects by a theme (Spec §6.3, §6.16, after WorkflowKeeper's D87): what an
// SVG picture can do of a machined card — a hard lip and a soft shadow under the shape, the fill, a brushed hairline
// texture, a band in the object's own colour along the top edge, a chamfer highlight under it and a shade along the
// bottom. The shapes stay the graph's own (D53): the document, the long hexagon, the oval, the round card of a folded
// group, the folder. Pure strings in, strings out, so it is tested with `node --test` (src/ui/graph-palette.test.ts);
// graph.js draws these as a second picture under the words and marks, behind cytoscape's own border.

/** The shapes cytoscape draws, in its -1..1 polygon points (graph.js uses the same strings). */
export const DOC_POLYGON = [[-1, -1], [0.72, -1], [1, -0.62], [1, 1], [-1, 1]];     // a document with a folded corner
export const HEX_POLYGON = [[-0.8, -1], [0.8, -1], [1, 0], [0.8, 1], [-0.8, 1], [-1, 0]];   // a long hexagon
const CARD_R = 6;
const FOLDER_TAB = { w: 78, h: 8 };

const num = (v) => String(Math.round(v * 100) / 100);

/** The outline of a shape as an SVG path, sized to the object (its top left at 0,0). */
export function shapePath(kind, w, h) {
  const poly = (pts) => `M${pts.map(([px, py]) => `${num((px + 1) / 2 * w)},${num((py + 1) / 2 * h)}`).join(' L')} Z`;
  if (kind === 'hex') return poly(HEX_POLYGON);
  if (kind === 'doc') return poly(DOC_POLYGON);
  if (kind === 'ellipse') return `M0,${num(h / 2)} A${num(w / 2)},${num(h / 2)} 0 1,0 ${num(w)},${num(h / 2)} A${num(w / 2)},${num(h / 2)} 0 1,0 0,${num(h / 2)} Z`;
  if (kind === 'folder') {
    const { w: tw, h: th } = FOLDER_TAB;
    return `M1,${th + 4} V4 Q1,1 4,1 H${tw - 10} L${tw},${th} H${num(w - 4)} Q${num(w - 1)},${th} ${num(w - 1)},${th + 4} V${num(h - 4)} Q${num(w - 1)},${num(h - 1)} ${num(w - 4)},${num(h - 1)} H4 Q1,${num(h - 1)} 1,${num(h - 4)} Z`;
  }
  const r = CARD_R;
  return `M${r},0 H${num(w - r)} A${r},${r} 0 0 1 ${num(w)},${r} V${num(h - r)} A${r},${r} 0 0 1 ${num(w - r)},${num(h)} H${r} A${r},${r} 0 0 1 0,${num(h - r)} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
}

/** The material a palette lends, or null when it lends none (the factory): then nothing is drawn under the words. */
export function materialOf(p) {
  if (!p.nodeChamfer && !p.nodeShade && !p.nodeBrush && !p.nodeLip && !p.nodeShadow) return null;
  return { bg: p.nodeBg, lip: p.nodeLip, shadow: p.nodeShadow, chamfer: p.nodeChamfer, shade: p.nodeShade, brush: p.nodeBrush };
}

/** How far the material reaches beyond the object: a lip and a shadow fall below it and a little to each side. */
export function materialRoom(m) {
  return m && (m.lip || m.shadow) ? { left: 12, bottom: 24 } : { left: 0, bottom: 0 };
}

/**
 * The material drawn for one shape at one size, in the object's own colour for the band. One line, so a picture can
 * be searched; ids are fixed because each picture is an SVG document of its own.
 */
export function materialSvg(kind, w, h, m, colour) {
  if (!m) return '';
  const d = shapePath(kind, w, h);
  const clip = 'clip-path="url(#ckm-clip)"';
  const defs = [`<clipPath id="ckm-clip"><path d="${d}"/></clipPath>`];
  if (m.brush) defs.push(`<pattern id="ckm-brush" width="3" height="1" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="${m.brush}"/></pattern>`);
  if (m.shadow) defs.push(`<filter id="ckm-shadow" x="-20%" y="-20%" width="140%" height="180%"><feDropShadow dx="0" dy="6" stdDeviation="5" flood-color="${m.shadow}"/></filter>`);
  const parts = [`<defs>${defs.join('')}</defs>`];
  if (m.shadow) parts.push(`<path d="${d}" fill="${m.bg}" filter="url(#ckm-shadow)"/>`);
  if (m.lip) parts.push(`<path d="${d}" fill="${m.lip}" transform="translate(0,3)"/>`);
  parts.push(`<path d="${d}" fill="${m.bg}"/>`);
  if (m.brush) parts.push(`<rect x="0" y="0" width="${num(w)}" height="${num(h)}" fill="url(#ckm-brush)" ${clip}/>`);
  parts.push(`<rect x="0" y="0" width="${num(w)}" height="3" fill="${colour}" ${clip}/>`);
  if (m.chamfer) parts.push(`<rect x="0" y="3" width="${num(w)}" height="2" fill="${m.chamfer}" ${clip}/>`);
  if (m.shade) parts.push(`<rect x="0" y="${num(h - 3)}" width="${num(w)}" height="3" fill="${m.shade}" ${clip}/>`);
  return parts.join('');
}
