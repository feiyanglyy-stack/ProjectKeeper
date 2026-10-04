// The story map's one placement model (D100; Spec §1.4 "落位", §6.3; CKC-09 AC-2, AC-15, AC-29; CKC-24 AC-18, AC-20):
// every drawn object gets a place from the relations the Keeper already writes, the Graph and the List read the same
// places, and what is not placed yet is counted where it would sit. An invented project ("Heron", a birdwatching log).
// The interface is plain ES modules without types, so they are loaded at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ui = (name: string) => new URL(`../../ui/${name}`, import.meta.url);
const P: any = await import(ui('placement.js').href);
const graph: any = await import(ui('graph.js').href);

const n = (id: string, category: string, extra: any = {}) => ({ id, category, label: extra.label ?? id, validity: 'Current', areaId: null, parentId: null, noteCount: 0, noteAttention: 0, ...extra });
let rid = 0;
const r = (type: string, from: string, to: string) => ({ id: `rel${++rid}`, type, from, to, basis: 'Explicit', assessment: 'Not assessed' });

/** Heron: two areas (Log, Maps), two plans in the project's own order (H2 before H1), an earlier generation. */
function heron() {
  const nodes = [
    n('prod', 'Product'), n('goal', 'Goal'),
    n('log', 'Area', { label: 'HM-1 · Log sightings' }), n('maps', 'Area', { label: 'HM-2 · Maps' }),
    n('h2', 'Plan', { label: 'H2 · Field season' }), n('h1', 'Plan', { label: 'H1 · First release' }),
    n('p0', 'Plan', { label: 'H0 · Prototype', validity: 'Replaced' }),
    // Work: in (Log × H2); in H1 serving Maps and the requirement at Log's top — solid in Log (the requirement it
    // fulfils, rule a), dashed in Maps — and listed in H2 too; in no plan; in H1 with no area.
    n('w1', 'Work item', { areaId: 'log', progress: 'In progress' }),
    n('w2', 'Work item', { areaId: 'maps', progress: 'Done', noteCount: 2, noteAttention: 1 }),
    n('w3', 'Work item', { areaId: 'log', progress: 'Planned' }),
    n('w4', 'Work item', { progress: 'Planned' }),
    n('w5', 'Work item', { progress: 'Planned' }),
    // Intent: a requirement at Log's top; a decision reaching both areas; an execution decision of H2; product-only; nothing.
    n('req', 'Requirement', { areaId: 'log' }), n('dMulti', 'Decision', { areaId: 'log' }), n('dExec', 'Decision'), n('dProd', 'Decision'), n('dNone', 'Decision'),
    // The earlier generation's items: dropped by a decision, moved into H1, carried on by w1, done with nothing recorded.
    n('o1', 'Work item', { validity: 'Replaced', replacedBy: 'dMulti', progress: 'Planned' }), n('o2', 'Work item', { progress: 'In progress' }),
    n('o3', 'Work item', { progress: 'Done' }), n('o4', 'Work item', { progress: 'Done', areaId: 'maps' }),
    n('rev', 'Review', { parentId: 'w4' }),
  ];
  const relations = [
    r('serves', 'w1', 'h2'), r('serves', 'w1', 'log'),
    r('serves', 'w2', 'h1'), r('serves', 'w2', 'h2'), r('serves', 'w2', 'maps'), r('serves', 'w2', 'req'),
    r('serves', 'w3', 'log'),
    r('serves', 'w5', 'h1'),
    r('refines', 'req', 'log'), r('refines', 'req', 'prod'),
    r('refines', 'dMulti', 'log'), r('refines', 'dMulti', 'maps'),
    r('refines', 'dExec', 'h2'), r('refines', 'dProd', 'prod'),
    r('serves', 'o2', 'h1'), r('serves', 'o2', 'p0'), r('replaces', 'w1', 'o3'), r('serves', 'o4', 'p0'),
  ];
  const generations = [{ id: 'gen0', name: 'Prototype generation', ended: { at: '2026-05-01' }, endedBy: { label: 'D7' }, workIds: ['o1', 'o2', 'o3', 'o4'], planIds: ['p0'] }];
  return { nodes, relations, generations };
}

test('a work item goes to (its area × its plan); the plans keep the project’s own order; a second plan or area is a relation out of its cell', () => {
  const M = P.placementOf(heron());
  assert.deepEqual(M.areas.map((a: any) => a.id), ['log', 'maps']);
  assert.deepEqual(M.plans.map((p: any) => p.id), ['h2', 'h1'], 'H2 before H1, as the project lists them; the replaced H0 is no band of its own');
  assert.deepEqual(M.place.get('w1'), { zone: 'cell', band: 'h2', area: 'log', areas: ['log'], by: 'named', gen: null, plan: 'h2' });
  assert.deepEqual(M.cells.get(P.cellKey('h2', 'log')), ['w1']);
  assert.equal(M.place.get('w2').band, 'h1', 'the first plan it serves is its band (Spec §1.4 "落在写在最前的那一个")');
  assert.equal(M.place.get('w2').area, 'log', 'solid in the module of the requirement it fulfils (rule a), though Maps is its own areaId');
  assert.deepEqual(M.place.get('w2').areas, ['log', 'maps']);
  assert.deepEqual(M.also.get('w2'), { areas: ['maps'], plans: ['h2'] }, 'dashed in Maps; listed in H2 too, a relation out of its band');
  assert.deepEqual(M.bands.map((b: any) => b.key), ['gen0', 'h2', 'h1', P.NO_PLAN], 'earlier generations above the current plans, `Not in a plan` last');
});

test('a requirement or decision on one area sits at its column’s top; one reaching several areas is in the ring; an execution decision is in its plan’s band', () => {
  const M = P.placementOf(heron());
  assert.deepEqual(M.place.get('req'), { zone: 'intent', area: 'log' });
  assert.deepEqual(M.intent.get('log'), ['req']);
  assert.deepEqual(M.place.get('dMulti'), { zone: 'ring', ring: 'multi', areas: ['log', 'maps'] }, 'its own areaId names only the first; the ring holds it, drawn to both columns');
  assert.deepEqual(M.place.get('dExec'), { zone: 'exec', band: 'h2' });
  assert.deepEqual(M.exec.get('h2'), ['dExec']);
  assert.deepEqual(M.ring.product, ['dProd'], 'only on the product is not a place (Spec §1.4)');
  assert.deepEqual(M.ring.none, ['dNone']);
});

test('where an object sits, in words for the top of its popover: a module, several, a plan, product only, not placed (owner 2026-09-30)', () => {
  const M = P.placementOf(heron(), { showReplaced: true });
  assert.deepEqual(P.whereItSits(M, 'req'), { kind: 'module', lead: 'On the module', ids: ['log'], note: null });
  assert.deepEqual(P.whereItSits(M, 'dMulti'), { kind: 'modules', lead: 'On 2 modules', ids: ['log', 'maps'], note: 'cross-cutting' });
  assert.deepEqual(P.whereItSits(M, 'dExec'), { kind: 'plan', lead: 'On the plan', ids: ['h2'], note: 'an execution decision' });
  assert.equal(P.whereItSits(M, 'dProd').lead, 'Product only', 'only on the product is not a place (Spec §1.4)');
  assert.equal(P.whereItSits(M, 'dNone').lead, 'Not placed yet');
  assert.deepEqual(P.whereItSits(M, 'w1'), { kind: 'work', lead: 'In', ids: ['log', 'h2'], note: null });
  assert.deepEqual(P.whereItSits(M, 'w4'), { kind: 'work', lead: 'In', ids: [], note: 'no module yet · not in a plan yet' });
  assert.equal(P.whereItSits(M, 'prod'), null, 'the product states no place');
  // What replaced it: an id, or the project's own number matched against what is still in force.
  assert.equal(P.replacementOf(M, 'dMulti')?.id, 'dMulti');
  assert.equal(P.replacementOf(M, 'HM-2')?.id, 'maps');
  assert.equal(P.replacementOf(M, 'H0'), null, 'a replaced object is not what replaces');
  assert.equal(P.replacementOf(M, null), null);
});

test('what is not placed yet is counted where it would sit: no plan in `Not in a plan` under its area, no area in the cross-cutting column', () => {
  const M = P.placementOf(heron());
  assert.deepEqual(M.place.get('w3'), { zone: 'cell', band: P.NO_PLAN, area: 'log', areas: ['log'], by: 'named', gen: null, plan: null });
  assert.deepEqual(M.place.get('w4'), { zone: 'cell', band: P.NO_PLAN, area: null, areas: [], by: null, gen: null, plan: null });
  assert.deepEqual(M.place.get('w5'), { zone: 'cell', band: 'h1', area: null, areas: [], by: null, gen: null, plan: 'h1' });
  assert.deepEqual(M.unplaced, { workNoPlan: 2, workNoArea: 3, workWholePlan: 0, workWrittenNoPlan: 0, workWrittenNoArea: 0, workNeither: 1, intentProductOnly: { Decision: 1 }, intentNowhere: { Decision: 1 }, intent: 2 });
  assert.ok(P.isUnplacedWork(M.place.get('w3')) && P.isUnplacedWork(M.place.get('w5')) && !P.isUnplacedWork(M.place.get('w1')));
});

test('an earlier item replaced by current work is carried on in it, not dropped; only a decision or an abandonment drops it', () => {
  const data = heron();
  const o4 = data.nodes.find((n: any) => n.id === 'o4');
  Object.assign(o4, { validity: 'Replaced', replacedBy: 'w1' });
  const g = P.placementOf(data).generations[0];
  const dest = Object.fromEntries(g.items.map((i: any) => [i.id, i.destination]));
  assert.deepEqual([dest.o4.kind, dest.o4.to, dest.o4.how], ['carried', 'w1', 'replaced by']);
  assert.equal(dest.o1.kind, 'dropped', 'replaced by a decision is still dropped by it');
  assert.equal(g.destinations.dropped, 1);
  // The project often writes the successor by its number rather than an id.
  const w1 = data.nodes.find((n: any) => n.id === 'w1');
  Object.assign(w1, { label: `K-9 ${w1.label}` });
  Object.assign(o4, { replacedBy: 'K-9' });
  const again = Object.fromEntries(P.placementOf(data).generations[0].items.map((i: any) => [i.id, i.destination]));
  assert.deepEqual([again.o4.kind, again.o4.to], ['carried', 'w1']);

  // Carried into work that was later deferred is still carried on; an item itself deferred is deferred, not dropped.
  Object.assign(w1, { validity: 'Deferred' });
  const o2 = data.nodes.find((n: any) => n.id === 'o2');
  Object.assign(o2, { validity: 'Deferred', replacedBy: null });
  const g3 = P.placementOf(data).generations[0];
  const d3 = Object.fromEntries(g3.items.map((i: any) => [i.id, i.destination]));
  assert.deepEqual([d3.o4.kind, d3.o4.deferred], ['carried', true]);
  assert.equal(P.destinationText(d3.o4), '→ carried on in ' + w1.label + ' (deferred)');
  assert.equal(d3.o2.kind, 'deferred');
  assert.match(P.destinationLine(g3.destinations), /1 deferred/);
  // Replaced with no successor recorded is not dropped: where it went is not recorded yet.
  Object.assign(o4, { validity: 'Replaced', replacedBy: null });
  const d4 = Object.fromEntries(P.placementOf(data).generations[0].items.map((i: any) => [i.id, i.destination]));
  assert.equal(d4.o4.kind, 'unrecorded');
});

test('an earlier generation’s band says where its work went — carried on, moved into the current plan, dropped by which decision — never “abandoned”', () => {
  const M = P.placementOf(heron());
  const g = M.generations[0];
  assert.deepEqual(g.planIds, ['p0']);
  const dest = Object.fromEntries(g.items.map((i: any) => [i.id, i.destination]));
  assert.equal(dest.o1.kind, 'dropped'); assert.equal(dest.o1.byLabel, 'dMulti');
  assert.deepEqual([dest.o2.kind, dest.o2.to], ['moved', 'h1']);
  assert.deepEqual([dest.o3.kind, dest.o3.to, dest.o3.how], ['carried', 'w1', 'replaces']);
  assert.deepEqual([dest.o4.kind, dest.o4.done], ['unrecorded', true]);
  assert.deepEqual(g.destinations, { planned: 4, done: 2, carried: 1, moved: 1, deferred: 0, dropped: 1, droppedBy: ['dMulti'], unrecorded: 1 });
  const line = P.destinationLine(g.destinations);
  assert.equal(line, '4 planned · 2 done · 1 carried on · 1 moved into the current plan · 1 dropped by dMulti · 1 where it went not recorded yet');
  assert.doesNotMatch(line, /abandon/i);
  assert.equal(M.place.get('o4').zone, 'gen', 'its items sit in its band, in their area’s column');
  assert.equal(M.place.get('o4').area, 'maps');
  assert.deepEqual([M.place.get('o2').zone, M.place.get('o2').band], ['cell', 'h1'], 'an item that moved into a current plan stands in that plan; the band only counts it as moved');
  assert.equal(g.organized, true);
});

test('the Graph’s folders and the List’s blocks count results by the same places', () => {
  const data = heron();
  const M = P.placementOf(data);
  const cells = graph.observedCells(data, false, M);
  assert.equal(cells.get(null).total, 1, 'the review of a work with no area is in the cross-cutting folder');
  assert.equal(cells.get('log').total, 0);
  // A work with no areaId of its own that serves an area stands in that area's column, and so do its results.
  const d2 = { ...data, nodes: [...data.nodes.filter((x: any) => x.id !== 'rev'), n('w6', 'Work item', { progress: 'Done' }), n('rev2', 'Review', { parentId: 'w6' })], relations: [...data.relations, r('serves', 'w6', 'maps')] };
  assert.equal(P.placementOf(d2).place.get('w6').area, 'maps');
  assert.equal(graph.observedCells(d2).get('maps').total, 1);
});

test('the notes on objects that still need the owner: their count and the objects, for the drawer and its filter (D100)', () => {
  const data = heron();
  data.relations[0] = { ...data.relations[0], noteAttention: 2 } as any;
  const a = P.objectAttentionNotes(data);
  assert.equal(a.count, 3);
  assert.deepEqual(a.ids, ['w2', data.relations[0]!.id]);
  assert.deepEqual(a.objects[1].ends, ['w1', 'h2']);
  assert.equal(graph.objectAttentionNotes, P.objectAttentionNotes, 'graph.js hands on the same function');
  // The mark: lit ❓ while a note needs the owner, quiet ❓ otherwise.
  assert.equal(graph.marksOf({ noteCount: 2, noteAttention: 1, marks: [] }, false)[0], graph.MARKS.ask);
  assert.equal(graph.marksOf({ noteCount: 1, noteAttention: 0, marks: [] }, false)[0], graph.MARKS.note);
  assert.equal(graph.MARKS.ask.glyph, '❓');
  assert.equal(graph.MARKS.note.glyph, '❓');
});

test('the story map’s layout: product and goals on top, areas as columns with their intent, the ring above every band, each work in its cell, folders at the foot', () => {
  const M = P.placementOf(heron());
  const A = M.areas.length;
  const col = (area: string | null) => (area ? M.areas.findIndex((a: any) => a.id === area) : A);
  const items: any[] = [
    { ...n('prod', 'Product'), slot: { zone: 'product' } }, { ...n('goal', 'Goal'), slot: { zone: 'goal' } },
    ...M.areas.map((a: any, i: number) => ({ ...a, slot: { zone: 'area', col: i } })),
    { ...n('req', 'Requirement'), slot: { zone: 'intent', col: 0 } },
    { ...n('dMulti', 'Decision'), slot: { zone: 'ring' } },
    { id: 'genhead:gen0', kind: 'genhead', w: graph.storyWidth(A) - 2 * graph.LAYOUT.edge, h: 44, slot: { zone: 'genhead', band: 'gen0', bi: 0 } },
    { ...n('h2', 'Plan'), slot: { zone: 'head', band: 'h2', bi: 1 } },
    { ...n('w1', 'Work item'), slot: { zone: 'cell', band: 'h2', bi: 1, col: col('log') } },
    { ...n('h1', 'Plan'), slot: { zone: 'head', band: 'h1', bi: 2 } },
    { ...n('w2', 'Work item'), slot: { zone: 'cell', band: 'h1', bi: 2, col: col('maps') } },
    { ...n('w5', 'Work item'), slot: { zone: 'cell', band: 'h1', bi: 2, col: col(null) } },
    { id: 'kstep:1', kind: 'proc-step', w: 204, h: 54, seq: 0, slot: { zone: 'cell', band: 'h1', bi: 2, col: col('maps'), after: 'w2', indent: 8 } },
    { id: 'folder:log', kind: 'folder', folder: 'log', slot: { zone: 'folder', col: 0 } },
    { id: 'folder:project-wide', kind: 'folder', folder: null, slot: { zone: 'folder', col: A } },
  ];
  const L = graph.storyLayout(items);
  const b = (id: string) => L.box.get(id);
  assert.ok(b('prod').y < b('goal').y && b('goal').y < b('log').y && b('log').y < b('req').y, 'product, goals, areas, then the intent under its area');
  assert.equal(b('req').x, L.colX[0]);
  assert.ok(L.ring && L.ring.y > b('req').y + b('req').h, 'the ring is under the requirement row');
  assert.ok(b('dMulti').y > L.ring.y && b('dMulti').y + b('dMulti').h < L.ring.y + L.ring.h, 'the ring holds what reaches several areas');
  assert.deepEqual(L.bands.map((x: any) => x.key), ['gen0', 'h2', 'h1'], 'the bands in their order, all under the ring');
  assert.ok(L.bands[0].y > L.ring.y + L.ring.h);
  const inBand = (id: string, key: string) => { const x = L.bands.find((y: any) => y.key === key); return b(id).y >= x.y && b(id).y + b(id).h <= x.y + x.h; };
  assert.ok(inBand('w1', 'h2') && inBand('h2', 'h2') && inBand('w2', 'h1') && inBand('w5', 'h1') && inBand('kstep:1', 'h1'));
  assert.equal(b('w1').x, L.colX[0], 'w1 in Log’s column');
  assert.equal(b('w2').x, L.colX[1], 'w2 in Maps’ column');
  assert.equal(b('w5').x, L.colX[A], 'no area: the cross-cutting column, right of the areas');
  assert.equal(b('h2').x, L.headX, 'the plan heads its band, left of the columns');
  assert.equal(b('kstep:1').y, b('w2').y + b('w2').h + graph.LAYOUT.vGap, 'a process step stands right under its work');
  assert.equal(b('genhead:gen0').w, L.width - 2 * graph.LAYOUT.edge, 'a rolled generation spans the map');
  assert.ok(b('folder:log').y > L.bands[2].y + L.bands[2].h, 'the folders below every band');
  assert.equal(b('folder:project-wide').x, L.colX[A]);
  const nodes = items.map((d) => { const x = b(d.id); return { id: d.id, label: d.id, x: x.x + x.w / 2, y: x.y + x.h / 2, w: x.w, h: x.h }; });
  assert.equal(graph.readabilityReport(nodes, [], { w: 4000, h: 3000 }).issues.find((i: any) => i.kind === 'overlap'), undefined, 'nothing on top of anything');
});

// ───────── A work item serving several modules (owner, 2026-09-30; Spec §1.4, §6.3; CKC-09 AC-47) ─────────
// "appear in every column it serves., 需要区分实线框和虚线框": solid in its main module — (a) the contract it implements,
// (b) else the module its ticket or prompt names (the first Area the Keeper wrote), (c) else the first listed — and a
// dashed copy in each other module. An invented project ("Kestrel", a ringing station's log).

/** Kestrel: two areas, one plan, a requirement under Nets, and work serving both areas. */
function kestrel() {
  const nodes = [
    n('prod', 'Product'),
    n('ring', 'Area', { label: 'KS-1 · Ringing' }), n('nets', 'Area', { label: 'KS-2 · Nets' }),
    n('k1', 'Plan', { label: 'K1 · Autumn' }),
    n('rNets', 'Requirement', { areaId: 'nets' }),
    // Implements the requirement under Nets, though the Keeper wrote Ringing first: solid in Nets (rule a).
    n('wContract', 'Work item', { areaId: 'ring', progress: 'Done', servesOrder: ['ring', 'k1', 'rNets', 'nets'] }),
    // No contract; its ticket names Ringing, written first — though the relations were stored the other way round.
    n('wTicket', 'Work item', { areaId: 'ring', progress: 'In progress', servesOrder: ['ring', 'nets', 'k1'] }),
    // Dispatch tickets implementing the contract work item, which serves two modules: one whose ticket names Ringing
    // stands in Ringing; one naming no module stands in the contract's main one, Nets (Spec §1.4).
    n('wRun', 'Work item', { areaId: 'ring', progress: 'Planned', servesOrder: ['ring', 'k1'] }),
    n('wRun2', 'Work item', { progress: 'Planned', servesOrder: ['k1'] }),
    n('res', 'Result', { parentId: 'wContract' }),
  ];
  const relations = [
    r('serves', 'wContract', 'ring'), r('serves', 'wContract', 'k1'), r('serves', 'wContract', 'rNets'), r('serves', 'wContract', 'nets'),
    r('refines', 'rNets', 'nets'),
    r('serves', 'wTicket', 'nets'), r('serves', 'wTicket', 'ring'), r('serves', 'wTicket', 'k1'),
    r('serves', 'wRun', 'ring'), r('serves', 'wRun', 'k1'), r('implements', 'wRun', 'wContract'),
    r('serves', 'wRun2', 'k1'), r('implements', 'wRun2', 'wContract'),
    r('produced', 'wContract', 'res'),
  ];
  return { nodes, relations, generations: [] };
}

test('a work item serving two areas is in both, solid in the module of the contract it implements', () => {
  const M = P.placementOf(kestrel());
  const p = M.place.get('wContract');
  assert.deepEqual([p.area, p.areas, p.by], ['nets', ['nets', 'ring'], 'contract'], 'rule a: the requirement it fulfils is under Nets');
  assert.ok(M.cells.get(P.cellKey('k1', 'nets')).includes('wContract') && M.cells.get(P.cellKey('k1', 'ring')).includes('wContract'), 'in (Nets × K1) and in (Ringing × K1)');
  assert.equal(P.isCopyIn(M, 'wContract', 'nets'), false, 'solid in Nets');
  assert.equal(P.isCopyIn(M, 'wContract', 'ring'), true, 'dashed in Ringing');
  assert.deepEqual(P.sharedMark(M, 'wContract', 'ring'), { copy: true, main: 'nets', others: ['ring'], by: 'contract', text: 'main in KS-2' }, 'the copy says where its main one is');
  assert.equal(P.sharedMark(M, 'wContract', 'nets').text, 'also in KS-1');
  // A ticket that implements a contract of two modules: the one its ticket names among them, else the contract's main one.
  assert.deepEqual([M.place.get('wRun').area, M.place.get('wRun').areas, M.place.get('wRun').by], ['ring', ['ring'], 'contract']);
  assert.deepEqual([M.place.get('wRun2').area, M.place.get('wRun2').areas, M.place.get('wRun2').by], ['nets', ['nets'], 'contract']);
  // Work serving one area is not marked.
  assert.equal(P.sharedMark(P.placementOf(heron()), 'w1', 'log'), null);
});

test('with no contract, solid in the first `serves` to an Area, read in the order the Keeper wrote it', () => {
  const M = P.placementOf(kestrel());
  const p = M.place.get('wTicket');
  assert.deepEqual([p.area, p.areas, p.by], ['ring', ['ring', 'nets'], 'named'], 'servesOrder puts Ringing first, whatever order the relations were stored in');
  // Without the written order the relations' order is all there is.
  const data = kestrel();
  data.nodes = data.nodes.map((x: any) => (x.id === 'wTicket' ? { ...x, servesOrder: undefined } : x));
  assert.equal(P.placementOf(data).place.get('wTicket').area, 'nets');
  // (c) neither a contract nor an Area written directly: the first area it reaches.
  const d2 = kestrel();
  d2.nodes.push(n('dNets', 'Decision', { areaId: 'nets' }), n('dRing', 'Decision', { areaId: 'ring' }), n('wFirst', 'Work item', { progress: 'Planned' }));
  d2.relations.push(r('serves', 'wFirst', 'dNets'), r('serves', 'wFirst', 'dRing'), r('serves', 'wFirst', 'k1'));
  const q = P.placementOf(d2).place.get('wFirst');
  assert.deepEqual([q.area, q.areas, q.by], ['nets', ['nets', 'ring'], 'first']);
});

test('its result is counted once, in the solid cell; the areas say how many of their work items are shared', () => {
  const data = kestrel();
  const M = P.placementOf(data);
  const cells = graph.observedCells(data, false, M);
  assert.equal(cells.get('nets').total, 1, 'the result is in the main module’s folder');
  assert.equal(cells.get('ring').total, 0, 'and not again under the copy');
  assert.deepEqual(M.areaWork.get('ring'), { total: 3, shared: 2, main: 1 }, 'wContract dashed, wTicket solid, wRun its own');
  assert.deepEqual(M.areaWork.get('nets'), { total: 3, shared: 2, main: 1 }, 'wContract solid, wTicket dashed, wRun2 its own');
  assert.equal(P.areaWorkLine(M.areaWork.get('ring')), '3 work items · 2 shared');
  assert.equal(P.areaWorkLine({ total: 1, shared: 0, main: 0 }), '1 work item');
  assert.equal(M.unplaced.workNoArea, 0, 'each work item counted once in what is not placed yet');
  // What a copy's relation to the area it stands in is: the column says it (no line), as for its own area.
  assert.deepEqual(M.also.get('wTicket'), { areas: ['nets'], plans: [] });
});

test('List rows: a shared work item has a row in each module’s block, solid in its main one and dashed in the others', () => {
  const M = P.placementOf(kestrel());
  const rows = (area: string) => P.listRowsOf(M, area).map((x: any) => [x.id, x.copy, x.mark?.text ?? null]);
  assert.deepEqual(rows('nets').sort(), [['wContract', false, 'also in KS-1'], ['wRun2', false, null], ['wTicket', true, 'main in KS-1']]);
  assert.deepEqual(rows('ring').sort(), [['wContract', true, 'main in KS-2'], ['wRun', false, null], ['wTicket', false, 'also in KS-2']]);
  // The heron's shared w2: solid in Log, dashed in Maps; the cross-cutting block lists the work of no area.
  const H = P.placementOf(heron());
  assert.deepEqual(P.listRowsOf(H, 'log').map((x: any) => [x.id, x.copy, x.mark?.copy ?? null]).sort(), [['w1', false, null], ['w2', false, false], ['w3', false, null]]);
  assert.deepEqual(P.listRowsOf(H, 'maps').map((x: any) => [x.id, x.copy, x.mark?.text ?? null]), [['w2', true, 'main in HM-1']]);
  assert.deepEqual(P.listRowsOf(H, null).map((x: any) => x.id).sort(), ['o2', 'w4', 'w5']);
  assert.ok(!P.listRowsOf(H, 'maps').some((x: any) => x.id === 'o4'), 'an earlier generation’s items are in its band, not in the block');
});

test('an item carried on under the same number is current work: it stands in its current plan (or waits for one), never in the generation’s band, which lists it as carried on', () => {
  const data = heron();
  // o2 serves the current plan H1; o5 is current work too, but serves only the earlier plan p0.
  data.nodes.push(n('o5', 'Work item', { label: 'K-5 Tally sheets', areaId: 'log' }) as any);
  data.relations.push(r('serves', 'o5', 'p0'), r('serves', 'o5', 'log'));
  Object.assign(data.generations[0]!, { workIds: ['o1', 'o2', 'o3', 'o4', 'o5'], carriedIds: ['o2', 'o5'] });
  const M = P.placementOf(data);
  const g = M.generations[0];
  const dest = Object.fromEntries(g.items.map((i: any) => [i.id, i.destination]));
  assert.deepEqual([dest.o2.kind, dest.o2.same, dest.o5.kind, dest.o5.same], ['carried', true, 'carried', true], 'not “moved into the current plan”: the same item went on');
  assert.equal(P.destinationText(dest.o2), '→ carried on under the same number');
  // o3 was carried on in w1 (it replaces it), so three are carried on in all; none is counted as moved.
  assert.deepEqual([g.destinations.planned, g.destinations.carried, g.items.filter((i: any) => i.destination.same).length, g.destinations.moved], [5, 3, 2, 0]);
  assert.match(P.destinationLine(g.destinations), /5 planned · \d+ done · 3 carried on/);
  assert.deepEqual([M.place.get('o2').zone, M.place.get('o2').band, M.place.get('o2').gen], ['cell', 'h1', null], 'in the plan it serves now');
  assert.deepEqual([M.place.get('o5').zone, M.place.get('o5').band, M.place.get('o5').gen], ['cell', P.NO_PLAN, null], 'with no current plan it is unplaced current work, not a card of the generation');
  assert.equal(P.isUnplacedWork(M.place.get('o5')), true);
  const inBand = [...M.cells].filter(([k]: [string]) => k.startsWith('gen0|')).flatMap(([, ids]: [string, string[]]) => ids);
  assert.ok(!inBand.includes('o2') && !inBand.includes('o5'), 'no second card in the generation’s band');
  // Deferred under the same number is still carried on, and says so.
  Object.assign(data.nodes.find((x: any) => x.id === 'o5')!, { validity: 'Deferred' });
  const again = Object.fromEntries(P.placementOf(data).generations[0].items.map((i: any) => [i.id, i.destination]));
  assert.equal(P.destinationText(again.o5), '→ carried on under the same number (deferred)');
  // Without the mark the item is the generation's, as before.
  Object.assign(data.nodes.find((x: any) => x.id === 'o5')!, { validity: 'Current' });
  Object.assign(data.generations[0]!, { carriedIds: [] });
  assert.deepEqual([P.placementOf(data).place.get('o5').zone, P.placementOf(data).place.get('o5').gen], ['gen', 'gen0']);
});

test('earlier generations: none recorded, no band; one the organizing did not organize says `Not organized`, with its name, end and ending document', () => {
  const none = P.placementOf({ ...heron(), generations: [] });
  assert.deepEqual(none.generations, []);
  assert.deepEqual(none.bands.map((b: any) => b.key), ['h2', 'h1', P.NO_PLAN], 'no band for a generation that is not there');
  const data = heron();
  data.generations.push({ id: 'gen1', name: 'Paper-log generation', ended: { at: '2026-06-01' }, endedBy: { label: 'D9' }, workIds: [], planIds: [] } as any);
  const M = P.placementOf(data);
  const g = M.generations.find((x: any) => x.id === 'gen1');
  assert.equal(g.organized, false);
  assert.equal(P.destinationLine(g.destinations), 'Not organized');
  assert.equal(P.NOT_ORGANIZED, 'Not organized');
  assert.deepEqual([g.name, g.ended.at, g.endedBy.label], ['Paper-log generation', '2026-06-01', 'D9']);
  assert.deepEqual(M.bands.map((b: any) => b.key), ['gen0', 'gen1', 'h2', 'h1', P.NO_PLAN], 'at the top, above the current plans, oldest first');
  assert.doesNotMatch(P.destinationLine(g.destinations), /not recorded yet/);
});

test('Inferred is written on the object and its frame stays solid; the one dashed frame is a work item’s copy', () => {
  const style = graph.graphStyle(graph.currentPalette());
  const dashed = style.filter((x: any) => x.selector.startsWith('node') && x.style['border-style'] === 'dashed').map((x: any) => x.selector);
  assert.deepEqual(dashed, ['node.copy'], 'no dashed frame for Inferred or for anything else');
  const pic = (extra: any) => decodeURIComponent(graph.objectImage(n('x', 'Requirement', { label: 'R-1 · Ring every bird', ...extra }), 228, 60, {}).uri);
  assert.match(pic({ basis: 'Inferred' }), />Inferred</, 'the word on the inferred object');
  assert.doesNotMatch(pic({ basis: 'Explicit' }), />Inferred</);
  assert.equal(graph.INFERRED_WORD, 'Inferred');
  // Inferred relations stay dotted.
  assert.equal(style.find((x: any) => x.selector === 'edge.inferred').style['line-style'], 'dotted');
});

test('a cross-cutting foundation is a column after every module, its own work and intent in it (D101; Spec §1.4, §6.3)', () => {
  const d = heron();
  // Named to sort first, it still goes last: the foundation is the base the modules share, not a module.
  d.nodes.push(n('base', 'Area', { label: 'AA · Shared runtime', foundation: true }), n('wBase', 'Work item', { progress: 'Planned' }), n('reqBase', 'Requirement'));
  d.relations.push(r('serves', 'wBase', 'h1'), r('serves', 'wBase', 'base'), r('refines', 'reqBase', 'base'));
  const M = P.placementOf(d);
  assert.deepEqual(M.areas.map((a: any) => a.id), ['log', 'maps', 'base'], 'modules by name, then the foundation');
  assert.deepEqual(M.cells.get(P.cellKey('h1', 'base')), ['wBase']);
  assert.deepEqual(M.intent.get('base'), ['reqBase'], 'what names the foundation sits in its column, not in the ring');
  assert.equal(P.FOUNDATION_LABEL, 'Cross-cutting foundation');
});

test('an item on the whole product with the Keeper’s written reason is placed in the ring’s `Whole product` group, not counted unplaced (CM; Spec §1.4)', () => {
  const d = heron();
  const why = 'How every document is written: it binds every module and plan alike';
  d.nodes.push(n('dWhole', 'Decision', { wholeProductWhy: why }), n('reqLoose', 'Requirement', { wholeProductWhy: 'no target' }), n('dAreaWhy', 'Decision', { wholeProductWhy: 'ignored' }));
  d.relations.push(r('refines', 'dWhole', 'goal'), r('refines', 'dAreaWhy', 'maps'));
  const M = P.placementOf(d);
  assert.deepEqual(M.place.get('dWhole'), { zone: 'ring', ring: 'whole', why });
  assert.deepEqual(M.ring.whole, ['dWhole']);
  assert.deepEqual(M.ring.product, ['dProd'], 'on the product without a written reason is still not placed');
  assert.ok(M.ring.none.includes('reqLoose'), 'a reason with nothing refined places nothing');
  assert.deepEqual(M.place.get('dAreaWhy'), { zone: 'intent', area: 'maps' }, 'an item that reaches an area sits there');
  assert.deepEqual(M.unplaced.intentProductOnly, { Decision: 1 });
  assert.equal(M.unplaced.intent, 3, 'dProd, dNone and reqLoose; the whole-product decision is placed');
  assert.deepEqual(P.whereItSits(M, 'dWhole'), { kind: 'whole', lead: 'Whole product', ids: [], note: why });
});

test('work for its whole plan is placed in the plan’s cross-cutting cell with the Keeper’s reason, and not counted as work in no area (CN, E152; Spec §1.4)', () => {
  const d = heron();
  const why = 'The season check judges every item of H1; it belongs to no single area';
  // w5 is in H1 with no area; wQc is in H1 with no area and says why; wLoose says why but is in no plan; wArea has an area.
  d.nodes.push(n('wQc', 'Work item', { label: 'HQ · Season check (HM-1～HM-2)', progress: 'Done', wholePlanWhy: why }), n('wLoose', 'Work item', { progress: 'Planned', wholePlanWhy: 'no plan to serve the whole of' }), n('wArea', 'Work item', { progress: 'Planned', wholePlanWhy: 'ignored: it serves an area' }));
  d.relations.push(r('serves', 'wQc', 'h1'), r('serves', 'wArea', 'h1'), r('serves', 'wArea', 'maps'));
  const before = P.placementOf(heron());
  const M = P.placementOf(d);
  assert.deepEqual(M.place.get('wQc'), { zone: 'cell', band: 'h1', area: null, areas: [], by: null, gen: null, plan: 'h1', whole: why });
  assert.deepEqual(M.cells.get(P.cellKey('h1', null)), ['w5', 'o2', 'wQc'], 'in the band’s cross-cutting cell, beside the work no record places in an area yet');
  assert.ok(!('whole' in M.place.get('w5')));
  assert.ok(!('whole' in M.place.get('wLoose')), 'it needs a plan');
  assert.ok(!('whole' in M.place.get('wArea')), 'work that serves an area stands there');
  assert.equal(M.unplaced.workNoArea, before.unplaced.workNoArea + 1, 'only wLoose is added to what has no area');
  assert.equal(M.unplaced.workWholePlan, 1);
  assert.equal(P.isUnplacedWork(M.place.get('wQc')), false);
  assert.equal(P.isUnplacedWork(M.place.get('w5')), true);
  assert.deepEqual(P.whereItSits(M, 'wQc'), { kind: 'work', lead: 'Whole plan of', ids: ['h1'], note: why });
  assert.deepEqual(P.listRowsOf(M, null).filter((x: any) => x.whole).map((x: any) => [x.id, x.whole]), [['wQc', why]]);
  assert.equal(P.WHOLE_PLAN_LABEL, 'Whole plan');
  // The story map draws it there: its own object in the cross-cutting column of its plan's band, not in a "no area yet" card.
  const lay = graph.storyLayout([
    ...['log', 'maps'].map((id) => ({ id, category: 'Area' })),
    { id: 'h1', category: 'Plan', slot: { zone: 'head', band: 'h1', bi: 0, kind: 'plan' } },
    { id: 'wQc', category: 'Work item', slot: { zone: 'cell', band: 'h1', bi: 0, col: 2, kind: 'plan' } },
  ]);
  assert.equal(lay.box.get('wQc').col, 2, 'the column after the areas: cross-cutting');
});
