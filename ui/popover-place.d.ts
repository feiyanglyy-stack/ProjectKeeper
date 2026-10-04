/** Types for popover-place.js, so the node tests under src/ check against them. The browser never loads this file. */
export interface Rect { left: number; top: number; right: number; bottom: number }
export type Side = 'right' | 'left' | 'bottom' | 'top';
export interface Placement { left: number; top: number; width: number; height: number; side: Side; covers: boolean; overlaps: boolean }
export function placePopover(options: {
  anchor: Rect;
  size: { width: number; height: number };
  bounds: Rect;
  gap?: number;
  margin?: number;
  prefer?: readonly Side[];
  keepSide?: Side | null;
  /** Rectangles to keep off when that can be helped (the pill at the bottom right). */
  avoid?: readonly Rect[];
}): Placement;
export function standBeside(ways: ReadonlyArray<() => Rect | null | undefined>): () => Rect | null;
