/**
 * Saved versions of the picture, for `Compare` (Spec §6.3, §6.5; owner D45). Two points in time can only be
 * compared if both were kept, so the picture is saved at the moments the owner would want to compare from: each
 * time they open the project, and at the end of each round of organizing.
 *
 * A version holds what a comparison needs — the objects, their state, where they hang, the relations and their
 * assessments — not the whole asset set. On this project that is about 59 KB, 11 KB gzipped, so a year of daily
 * versions is a few megabytes.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { ProjectStore } from './project-store.ts';

export type VersionReason = 'Opened' | 'Organized' | 'Asked';

export interface VersionNode {
  readonly id: string;
  readonly category: string;
  readonly label: string;
  readonly validity: string;
  readonly progress: string | null;
  readonly acceptance: string;
  readonly areaId: string | null;
  readonly parentId: string | null;
  /** A digest of the object's own text, so a rewrite shows up as a content change without keeping the text twice. */
  readonly text: string;
}
export interface VersionRelation {
  readonly id: string;
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly assessment: string;
}
export interface Version {
  readonly id: string;
  readonly at: string;
  readonly reason: VersionReason;
  readonly nodes: readonly VersionNode[];
  readonly relations: readonly VersionRelation[];
}
export interface VersionInfo { readonly id: string; readonly at: string; readonly reason: VersionReason; readonly nodes: number; readonly relations: number; readonly bytes: number }

const digest = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12);
const versionsDir = (projectDir: string) => join(projectDir, 'versions');

/** The current picture, in the shape a comparison reads. */
export function snapshot(store: ProjectStore, reason: VersionReason, at = new Date().toISOString()): Version {
  const textOf = (n: { refKind: string; refId: string }): string => {
    if (n.refKind === 'reference') return store.reference.get(n.refId)?.text ?? '';
    if (n.refKind === 'thread') { const t = store.threads.get(n.refId); return t ? `${t.doing}\0${t.results}\0${t.unresolved}\0${t.doneMeans ?? ''}` : ''; }
    if (n.refKind === 'change') return store.changes.get(n.refId)?.summary ?? '';
    return '';
  };
  return {
    id: at.replace(/[:.]/g, '-'),
    at,
    reason,
    nodes: store.nodes.all().map((n) => ({
      id: n.id, category: n.category, label: n.label, validity: n.validity, progress: n.progress ?? null,
      acceptance: (n as { acceptance?: string }).acceptance ?? '', areaId: n.areaId ?? null, parentId: n.parentWorkId ?? null,
      text: digest(textOf(n)),
    })),
    relations: store.relations.all().map((r) => ({ id: r.id, type: r.type, from: r.from, to: r.to, assessment: r.assessment })),
  };
}

/** Save a version unless the picture is identical to the newest one; returns what was saved, or null. */
export function saveVersion(projectDir: string, store: ProjectStore, reason: VersionReason, keep = 400): Version | null {
  const dir = versionsDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const version = snapshot(store, reason);
  const list = listVersions(projectDir);
  const newest = list[list.length - 1];
  if (newest) {
    const previous = readVersion(projectDir, newest.id);
    if (previous && sameShape(previous, version)) return null;
  }
  writeFileSync(join(dir, `${version.id}__${reason}.json.gz`), gzipSync(Buffer.from(JSON.stringify(version), 'utf8')));
  const all = listVersions(projectDir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, fileOf(old.id, old.reason)), { force: true });
  return version;
}

const fileOf = (id: string, reason: string) => `${id}__${reason}.json.gz`;

function sameShape(a: Version, b: Version): boolean {
  if (a.nodes.length !== b.nodes.length || a.relations.length !== b.relations.length) return false;
  const key = (v: Version) => JSON.stringify([v.nodes.map((n) => [n.id, n.validity, n.progress, n.acceptance, n.areaId, n.parentId, n.text, n.label]).sort(), v.relations.map((r) => [r.id, r.assessment, r.from, r.to]).sort()]);
  return key(a) === key(b);
}

export function listVersions(projectDir: string): VersionInfo[] {
  const dir = versionsDir(projectDir);
  if (!existsSync(dir)) return [];
  const out: VersionInfo[] = [];
  for (const file of readdirSync(dir)) {
    const m = /^(.+)__(Opened|Organized|Asked)\.json\.gz$/.exec(file);
    if (!m) continue;
    const raw = readFileSync(join(dir, file));
    let v: Version | null = null;
    try { v = JSON.parse(gunzipSync(raw).toString('utf8')) as Version; } catch { continue; }
    out.push({ id: m[1]!, at: v.at, reason: m[2] as VersionReason, nodes: v.nodes.length, relations: v.relations.length, bytes: raw.length });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function readVersion(projectDir: string, id: string): Version | null {
  const dir = versionsDir(projectDir);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.startsWith(`${id}__`));
  if (!file) return null;
  try { return JSON.parse(gunzipSync(readFileSync(join(dir, file))).toString('utf8')) as Version; } catch { return null; }
}

export type DiffKind = 'Added' | 'Removed' | 'Content changed' | 'Regrouped' | 'Relinked';
export interface DiffItem {
  readonly kind: DiffKind;
  readonly id: string;
  readonly label: string;
  readonly category: string;
  /** What changed, in the words of the fields that differ; empty for Added and Removed. */
  readonly detail: string;
}

/**
 * The five kinds of difference between two versions (Spec §6.3):
 * `Added` and `Removed` are objects; `Content changed` is an object whose own text, state, progress or acceptance
 * moved; `Regrouped` is an object that hangs somewhere else now; `Relinked` is an object whose relations changed.
 * An object can only be counted once, in the first kind that applies, so the counts add up to the objects touched.
 */
export function diffVersions(before: Version, after: Version): { items: DiffItem[]; counts: Record<DiffKind, number> } {
  const a = new Map(before.nodes.map((n) => [n.id, n]));
  const b = new Map(after.nodes.map((n) => [n.id, n]));
  const relKey = (r: VersionRelation) => `${r.type}:${r.from}>${r.to}`;
  const relsOf = (v: Version) => {
    const m = new Map<string, Set<string>>();
    for (const r of v.relations) for (const end of [r.from, r.to]) { if (!m.has(end)) m.set(end, new Set()); m.get(end)!.add(`${relKey(r)}#${r.assessment}`); }
    return m;
  };
  const ra = relsOf(before), rb = relsOf(after);
  const items: DiffItem[] = [];
  for (const [id, n] of b) if (!a.has(id)) items.push({ kind: 'Added', id, label: n.label, category: n.category, detail: '' });
  for (const [id, n] of a) if (!b.has(id)) items.push({ kind: 'Removed', id, label: n.label, category: n.category, detail: '' });
  for (const [id, after1] of b) {
    const before1 = a.get(id);
    if (!before1) continue;
    const changed: string[] = [];
    if (before1.validity !== after1.validity) changed.push(`validity ${before1.validity} → ${after1.validity}`);
    if (before1.progress !== after1.progress) changed.push(`progress ${before1.progress ?? '—'} → ${after1.progress ?? '—'}`);
    if (before1.acceptance !== after1.acceptance) changed.push(`acceptance ${before1.acceptance || '—'} → ${after1.acceptance || '—'}`);
    if (before1.label !== after1.label) changed.push('name rewritten');
    if (before1.text !== after1.text) changed.push('text rewritten');
    if (changed.length > 0) { items.push({ kind: 'Content changed', id, label: after1.label, category: after1.category, detail: changed.join('; ') }); continue; }
    if (before1.areaId !== after1.areaId || before1.parentId !== after1.parentId) {
      const name = (x: string | null) => (x ? b.get(x)?.label ?? a.get(x)?.label ?? x : 'nothing');
      items.push({ kind: 'Regrouped', id, label: after1.label, category: after1.category, detail: `hangs from ${name(before1.areaId ?? before1.parentId)} → ${name(after1.areaId ?? after1.parentId)}` });
      continue;
    }
    const setA = ra.get(id) ?? new Set<string>(), setB = rb.get(id) ?? new Set<string>();
    const gained = [...setB].filter((x) => !setA.has(x)).length;
    const lost = [...setA].filter((x) => !setB.has(x)).length;
    if (gained || lost) items.push({ kind: 'Relinked', id, label: after1.label, category: after1.category, detail: `${gained} relation${gained === 1 ? '' : 's'} gained, ${lost} lost` });
  }
  const counts = { 'Added': 0, 'Removed': 0, 'Content changed': 0, 'Regrouped': 0, 'Relinked': 0 } as Record<DiffKind, number>;
  for (const i of items) counts[i.kind]++;
  const order: DiffKind[] = ['Added', 'Content changed', 'Regrouped', 'Relinked', 'Removed'];
  items.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || x.label.localeCompare(y.label));
  return { items, counts };
}
