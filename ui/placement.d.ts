/**
 * Types for placement.js, for what the program reads of it under src/ (DB: the program's counts of what is not placed
 * are the workbench's own — src/keeper/organize/workbench-placement.ts). The browser never loads this file.
 */
export interface PlacementNode {
  readonly id: string;
  readonly category: string;
  readonly label?: string;
  readonly validity?: string;
  readonly progress?: string | null;
  readonly areaId?: string | null;
  readonly parentId?: string | null;
  readonly group?: string | null;
  readonly replacedBy?: string | null;
  readonly recentChange?: boolean;
  readonly servesOrder?: readonly string[];
  readonly foundation?: true;
  readonly wholeProductWhy?: string;
  readonly wholePlanWhy?: string;
  readonly noPlanWhy?: string;
  readonly noAreaWhy?: string;
}
export interface PlacementRelation { readonly type: string; readonly from: string; readonly to: string }
export interface PlacementGeneration {
  readonly id: string;
  readonly name: string;
  readonly started?: unknown;
  readonly ended?: { readonly at?: string } | null;
  readonly endedBy?: unknown;
  readonly workIds?: readonly string[];
  readonly carriedIds?: readonly string[];
  readonly planIds?: readonly string[];
}
export interface PlacementData {
  readonly nodes: readonly PlacementNode[];
  readonly relations: readonly PlacementRelation[];
  readonly generations?: readonly PlacementGeneration[];
}
/** Where one object sits (see placementOf in placement.js for each zone). */
export interface Place {
  readonly zone: 'words' | 'product' | 'goal' | 'area' | 'gen-plan' | 'head' | 'gen' | 'cell' | 'exec' | 'intent' | 'ring' | 'result';
  readonly band?: string;
  readonly area?: string | null;
  readonly areas?: readonly string[];
  readonly by?: 'contract' | 'named' | 'first' | null;
  readonly gen?: string | null;
  readonly plan?: string | null;
  readonly ring?: 'multi' | 'whole' | 'product' | 'none';
  readonly why?: string;
  readonly whole?: string;
  readonly noPlanWhy?: string;
  readonly noAreaWhy?: string;
  /** A work item in `Not in a plan`: the plans it serves that have no band (not current, or an earlier generation's). */
  readonly plansNotDrawn?: readonly string[];
  readonly work?: string | null;
}
export interface UnplacedCounts {
  readonly workNoPlan: number;
  readonly workNoArea: number;
  readonly workWholePlan: number;
  readonly workWrittenNoPlan: number;
  readonly workWrittenNoArea: number;
  readonly workNeither: number;
  readonly intentProductOnly: Readonly<Record<string, number>>;
  readonly intentNowhere: Readonly<Record<string, number>>;
  readonly intent: number;
}
export interface UnplacedLists {
  readonly workNoPlan: readonly string[];
  readonly workNoArea: readonly string[];
  readonly workWholePlan: readonly string[];
  readonly workWrittenNoPlan: readonly string[];
  readonly workWrittenNoArea: readonly string[];
  readonly workNeither: readonly string[];
  readonly intentProductOnly: readonly string[];
  readonly intentNowhere: readonly string[];
}
export interface Placement {
  readonly areas: readonly PlacementNode[];
  /** The current plans: the ones the workbench draws a band for. */
  readonly plans: readonly PlacementNode[];
  readonly generations: readonly { readonly id: string; readonly name: string; readonly planIds: readonly string[]; readonly workIds: readonly string[] }[];
  readonly place: ReadonlyMap<string, Place>;
  readonly ring: { readonly multi: readonly string[]; readonly whole: readonly string[]; readonly product: readonly string[]; readonly none: readonly string[] };
  readonly unplaced: UnplacedCounts;
  readonly byId: ReadonlyMap<string, PlacementNode>;
}
export const NO_PLAN: string;
export const HIDDEN_VALIDITY: ReadonlySet<string>;
export function placementOf(data: PlacementData, options?: { showReplaced?: boolean }): Placement;
export function unplacedOf(M: Pick<Placement, 'place' | 'ring'>): UnplacedLists;
export function isUnplacedWork(p: Place | undefined | null): boolean;
