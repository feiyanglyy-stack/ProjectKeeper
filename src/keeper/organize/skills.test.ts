/**
 * The clerk method's skills (D99; Spec §3.3 "每个阶段一份 skill"; E148 D-b): one pi SKILL.md per stage of the main
 * agent, per kind of lane, and for the spot-check, in the install's `skills/clerk`. pi must load every one of them
 * without a diagnostic; the program must find a body for every stage and lane kind; every `pk_*` tool a skill names
 * must exist and be offered to the job that reads that skill (a stage's writers, a lane's slot writers, the
 * spot-check's writers); the folder is the install's, not the project's; and the read boundary opens it to the jobs
 * pi loaded it for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, loadSkillsFromDir, parseFrontmatter, type SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ClerkStage, LaneKind } from '../../model/k-types.ts';
import type { Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { CLERK_WRITER_STEPS, LANE_ALWAYS, MAIN_ALWAYS, ROUND_STAGES, SLOT_WRITERS, STAGE_WRITERS } from '../clerk-steps.ts';
import { STEP_WRITES } from '../roles.ts';
import { allowedRoots } from '../bounds/boundary.ts';
import { makeBoundary } from '../bounds/paths.ts';
import { pathKey } from '../../util/paths.ts';
import { OPEN_KEYS } from './round-open.ts';
import { EXTRA_KEYS } from './stage-tools.ts';
import {
  CLERK_SKILL_NAMES, LANE_SKILLS, STAGE_SKILLS, SPOT_CHECK_SKILL, SYNTHESIS_SKILL,
  clerkSkillFile, clerkSkillPathsFor, clerkSkillsDir, isClerkSkillPath, laneSkill, spotCheckSkill, stageSkill, synthesisSkill,
} from './skills.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..', '..');
const skillText = (name: string) => readFileSync(clerkSkillFile(name), 'utf8');
const toolsNamed = (text: string) => new Set(text.match(/\bpk_[a-z_]+[a-z]\b/g) ?? []);

const STAGES = [...new Set(Object.values(ROUND_STAGES).flat())] as ClerkStage[];
const LANE_KINDS: readonly LaneKind[] = ['slot', 'plan', 'topic', 'follow-up'];

// ───────────────────────── pi loads them ─────────────────────────

test('every clerk skill parses with pi’s loadSkillsFromDir with no diagnostics, one folder per skill, named as its folder', () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: clerkSkillsDir(), source: 'path' });
  assert.deepEqual(diagnostics, [], 'no diagnostics');
  assert.deepEqual(skills.map((s) => s.name).sort(), [...CLERK_SKILL_NAMES].sort(), 'exactly the clerk skills');
  assert.equal(CLERK_SKILL_NAMES.length, 12);
  for (const s of skills) {
    assert.equal(s.name, s.baseDir.split(/[\\/]/).pop(), `${s.name}: the name is its folder's`);
    const { frontmatter } = parseFrontmatter(readFileSync(s.filePath, 'utf8'));
    assert.equal(frontmatter.name, s.name, `${s.name}: frontmatter name`);
    assert.ok(s.description.length > 80 && s.description.length <= 1024, `${s.name}: a description pi can list`);
    assert.equal(s.disableModelInvocation, false, `${s.name}: listed for the model`);
  }
  // Nothing else in the folder that pi would take for a skill or that a reader would take for part of the method.
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(clerkSkillsDir(), join(d, n))]));
  assert.deepEqual(walk(clerkSkillsDir()).sort(), CLERK_SKILL_NAMES.map((n) => join(n, 'SKILL.md')).sort());
});

// ───────────────────────── the program finds a body for each ─────────────────────────

test('stageSkill and laneSkill return a body without frontmatter for every ClerkStage and LaneKind; spotCheckSkill too', () => {
  assert.deepEqual(Object.keys(STAGE_SKILLS).sort(), [...STAGES].sort(), 'every stage of every kind of round has a skill');
  for (const stage of STAGES) {
    const body = stageSkill(stage);
    assert.ok(body.length > 500 && body.startsWith('# '), `${stage}: a body that starts at its title`);
    assert.ok(!body.includes('\ndescription:') && !body.startsWith('---'), `${stage}: no frontmatter`);
  }
  for (const kind of LANE_KINDS) {
    const body = laneSkill(kind);
    assert.ok(body.length > 500 && body.startsWith('# '), `${kind}: a body`);
    assert.match(body, /pk_write_round_doc/, `${kind}: a lane writes its report`);
  }
  assert.deepEqual(Object.keys(LANE_SKILLS).sort(), [...LANE_KINDS].sort());
  assert.ok(spotCheckSkill().startsWith('# '));
  // D103: the synthesis is no stage of the main agent's; its skill heads the synthesis job's prompt.
  assert.ok(!STAGES.includes('synthesis') && !('synthesis' in STAGE_SKILLS));
  assert.throws(() => stageSkill('synthesis'), /no clerk skill for the stage "synthesis"/);
  assert.ok(synthesisSkill().length > 500 && synthesisSkill().startsWith('# ') && !synthesisSkill().includes('\ndescription:'));
  assert.ok(CLERK_SKILL_NAMES.includes(SYNTHESIS_SKILL));
});

test('the skills carry the D99 method: all lanes in one call, fill before judging, history per question, missing only after looking', () => {
  for (const stage of ['skeleton', 'dig'] as const) assert.match(stageSkill(stage), /pk_send_lanes`? \*\*once, with every lane/, `${stage}: all lanes in one call`);
  assert.match(stageSkill('coverage'), /send all of them in one call/);
  for (const name of ['lane-slot', 'skeleton-dispatch', 'reconcile']) assert.match(skillText(name), /pk_fill_from_table/, `${name}: copy the tables`);
  assert.match(laneSkill('slot'), /before judging/);
  for (const name of ['orientation', 'deepen-dispatch', 'lane-slot', 'lane-plan', 'lane-topic', 'lane-follow-up']) {
    assert.match(skillText(name), /never version by version|never read it version by version|Never tell a lane to read every version/, `${name}: history per question`);
  }
  // "Missing" is never concluded in the first usable round; a deepening lane that looked records it; one that found links.
  assert.match(laneSkill('slot'), /concludes nothing missing/);
  assert.match(stageSkill('reconcile'), /Don't conclude that anything is missing/);
  assert.match(laneSkill('plan'), /pk_record_looked\(\{ breakpointId, where \}\)/);
  assert.match(laneSkill('plan'), /pk_link_process/);
  assert.match(stageSkill('cross-check'), /Never light a breakpoint/);
  assert.match(spotCheckSkill(), /Every breakpoint candidate a lane looked at/);
  assert.match(spotCheckSkill(), /A sample of the rest/);
  // The brief's seven parts, the seventh the slots.
  assert.match(stageSkill('orientation'), /seven parts[\s\S]*7\. \*\*Slots\.\*\*/);
  // The quality rules in every skill an agent starts from.
  for (const name of ['orientation', 'lane-slot', 'lane-plan', 'lane-topic', 'lane-follow-up', 'synthesis', 'spot-check']) {
    const t = skillText(name);
    assert.match(t, /Cite everything/, `${name}: cite`);
    assert.match(t, /[Uu]nsure means say unsure/, `${name}: unsure`);
    assert.match(t, /owner's words verbatim/, `${name}: verbatim`);
    assert.match(t, /How the owner reads your results/, `${name}: the vocabulary`);
  }
});

// ───────────────────────── where the first D99 deepening fell short (CD) ─────────────────────────

test('every breakpoint candidate goes to a lane and gets one result there: linked, or looked with where; the Report lists each', () => {
  // The main agent gives each candidate to the lane whose plan or topic covers it, listed by id in that brief; one no
  // lane covers goes to a follow-up lane or the main agent's own cross-check.
  const dispatch = stageSkill('dig');
  assert.ok(/Give each one to the lane whose plan or topic covers its object/.test(dispatch));
  assert.ok(/Name every candidate by id in exactly one brief/.test(dispatch));
  assert.ok(/A candidate no lane covers[\s\S]{0,200}follow-up lane[\s\S]{0,120}your own cross-check/.test(dispatch));
  assert.ok(/one result per candidate/.test(dispatch));
  assert.ok(/list the breakpoint candidates the lane owns: every one by id/.test(stageSkill('orientation')));
  // Each lane that owns candidates: exactly one of the two results for each, no third; the Report lists every one.
  for (const kind of ['plan', 'topic', 'follow-up'] as const) {
    const body = laneSkill(kind);
    assert.ok(/give (?:exactly )?one result|one result each/i.test(body), `${kind}: one result per candidate`);
    assert.ok(/\*\*Found it, and linked it\.\*\*[\s\S]*pk_link_process[\s\S]*pk_record_carry_out/.test(body), `${kind}: found → the writer that puts it out`);
    assert.ok(/\*\*Looked, and did not find it\.\*\*[\s\S]*pk_record_looked\(\{ breakpointId, where \}\)/.test(body), `${kind}: looked → where`);
    assert.ok(/There is no third result/.test(body), `${kind}: no skipping`);
    assert.ok(/\*\*Candidates:\*\* every candidate your brief gave, each with its one result/.test(body), `${kind}: the Report lists every candidate`);
  }
  // The coverage stage sends what is still open with a follow-up lane; the cross-check goes through every one left.
  assert.ok(/Candidates with no result\.\*\* Every one goes into a follow-up lane's brief/.test(stageSkill('coverage')));
  assert.ok(/Every breakpoint candidate has a result[\s\S]*Go through every one; don't sample/.test(stageSkill('cross-check')));
  assert.ok(/pk_confirm` kind breakpoint, `confirmed: false`/.test(stageSkill('cross-check')));
});

test('placement: work items in a plan and a module from the project’s records, owner decisions on their modules, execution decisions on their plan', () => {
  const where = { slot: laneSkill('slot'), plan: laneSkill('plan'), topic: laneSkill('topic'), reconcile: stageSkill('reconcile'), 'cross-check': stageSkill('cross-check') };
  for (const [name, body] of Object.entries(where)) {
    assert.ok(/plan and (?:a |its )?module/.test(body), `${name}: a work item in a plan and a module`);
    assert.ok(/dispatch table/.test(body), `${name}: taken from the dispatch tables`);
    assert.ok(/prompt's metadata/.test(body), `${name}: and the prompts' metadata`);
    assert.ok(/pk_write_thread` `serves`: the Area/.test(body), `${name}: written as serves, the Area first`);
    assert.ok(/[Ee]xecution decision[\s\S]{0,200}(?:plan|Plan) whose (?:execution|work) (?:it|they) records?/.test(body), `${name}: an execution decision on its plan`);
    // D104: the lines are named in general words (an "affects" or "documents changed" line), not one project's.
    assert.ok(/an "affects" or "documents changed" line/.test(body), `${name}: an owner decision traced through what it changes`);
    assert.ok(/really concerns? the whole product/.test(body), `${name}: Product only when it really is the whole product`);
    // D104: a reason stands only where the records lead nowhere, and the program refuses it otherwise.
    assert.ok(/When the records lead nowhere[\s\S]{0,400}noPlanWhy/.test(body), `${name}: unplaced only where the records lead nowhere, with the reason recorded`);
  }
  assert.ok(/Place what you write/.test(laneSkill('follow-up')));
  assert.ok(/Placement: where the project records it/.test(stageSkill('orientation')));
});

test('a work item serving several modules: a `serves` to each Area, its main module written first by the owner’s rule a → b → c, quoted verbatim (owner, 2026-09-30)', () => {
  const where = { slot: laneSkill('slot'), plan: laneSkill('plan'), topic: laneSkill('topic'), 'follow-up': laneSkill('follow-up'), reconcile: stageSkill('reconcile'), 'cross-check': stageSkill('cross-check') };
  const rule = '「a.这项工作实现的合同属于哪个模块，就放哪； b.没有合同的，看派工单或提示词写的是哪个模块； c.都没写，才用"写在最前的"。」';
  for (const [name, body] of Object.entries(where)) {
    assert.ok(/A work item serving several modules\*\* gets a `serves` to each of their Areas/.test(body), `${name}: a serves to each Area`);
    assert.ok(/\*\*Write the main module's Area first\.\*\*/.test(body), `${name}: the main one first`);
    assert.equal(body.split(rule).length - 1, 1, `${name}: the owner’s rule, verbatim, once`);
    assert.ok(/\(a\) The module of the contract it implements[\s\S]{0,200}\(b\) With no contract, the module its dispatch ticket or prompt names[\s\S]{0,80}\(c\) With neither, the one its record lists first/.test(body), `${name}: a, b, c`);
    assert.ok(/the first Area written stays first[\s\S]{0,120}`replaceServes: true`, the main Area first/.test(body), `${name}: serves keeps its order; replaceServes moves the main one`);
  }
});

test('generations: each earlier generation holds its items and where each went — carried on, finished and built upon, or dropped — never simply abandoned', () => {
  for (const [name, body] of Object.entries({ orientation: stageSkill('orientation'), reconcile: stageSkill('reconcile'), slot: laneSkill('slot'), topic: laneSkill('topic') })) {
    assert.ok(/[Cc]arried on into the current plan[\s\S]*replacedBy the current work item/.test(body), `${name}: carried on, pointing at the item`);
    assert.ok(/[Ff]inished, and built upon/.test(body), `${name}: finished and built upon`);
    assert.ok(/[Dd]ropped[\s\S]{0,90}validity Abandoned, with the decision/.test(body), `${name}: dropped, by which decision`);
    assert.ok(/Never label a generation as simply abandoned/.test(body), `${name}: never simply abandoned`);
  }
  assert.ok(/For each earlier generation, answer with what it planned and where each item went/.test(synthesisSkill()));
  assert.ok(/Never call a generation simply abandoned/.test(synthesisSkill()));
  // The owner's words, verbatim, where the rule is given.
  for (const body of [stageSkill('orientation'), synthesisSkill(), laneSkill('topic')]) assert.ok(body.includes('「这两代不是完全废弃了，只是当时做到了一半或者全做完了，然后后面的其实在他基础上做的」'));
});

test('coverage: a group that holds what nothing carries is never accounted for as a group — one line pointing at the program’s counts (DA)', () => {
  const body = stageSkill('coverage');
  // DA (E156): the paragraph that named the execution records and what was "open" let a run write off 637 materials in 80
  // seconds once the open counts were 0; the program now counts what each group holds, and the skill points at the count.
  assert.ok(/\*\*A group with `holds` is never accounted for as a group\.\*\* `holds` is the program's count of what its materials hold that nothing carries \(verdict lines no work item links, numbers no item carries, the owner's lines not looked at yet\): send a lane for the materials it names, or account for each by key with its own reason \(`each: \[\{ key, why \}\]`\)\./.test(body));
  assert.doesNotMatch(body, /while anything is open|While any work item is in no plan/, 'the rule that rested on the open counts is gone');
  assert.ok(/"Not needed" is not a way to close the list\./.test(body), 'the judgement stays the main agent’s');
  // The orientation carries the lane skill's own definition of what a line becomes, so a brief does not redefine the item.
  assert.ok(/It judges each line by its own skill, never by your brief: a line about what the product is, a decision, a correction or a working rule becomes an item \(the working rules it reports, for you to write\); a line for that moment only is judged "needs nothing"\./.test(stageSkill('orientation')));
  for (const kind of ['slot', 'topic'] as const) assert.ok(/A line for that moment only needs nothing: say so with `pk_judge_owner_lines`, and it is not listed again\./.test(laneSkill(kind)), `${kind}: the third outcome is recorded`);
});

test('the round-state lists the skills point at exist by that key, and no skill reads the whole of `open` any more (CM)', () => {
  const keys = new Set([...Object.keys(OPEN_KEYS), ...EXTRA_KEYS.map((k) => k.key)]);
  const asked = CLERK_SKILL_NAMES.flatMap((n) => [...skillText(n).matchAll(/pk_round_state\(\{ list: "(\w+)" \}\)/g)].map((m) => [n, m[1]!] as const));
  assert.ok(asked.length >= 10, 'the skills fetch a list by its key when they act on it');
  assert.deepEqual(asked.filter(([, k]) => !keys.has(k)), [], 'every list a skill asks for is a key of pk_round_state');
  // A key named bare (`noPlan`, `designsWide`) is a count the skill reads; it is a real key too.
  // CQ (D104): `noPlanWhy` and `noAreaWhy` are fields of a work item, not lists.
  const bare = CLERK_SKILL_NAMES.flatMap((n) => [...skillText(n).matchAll(/`((?:no|designs|generation|without|stuck|number|other)[A-Z]\w+|onNothing|productOnly|traceable|misplaced|entries|candidates)`/g)].map((m) => [n, m[1]!] as const)).filter(([, k]) => !k.endsWith('Why'));
  assert.deepEqual(bare.filter(([, k]) => !keys.has(k)), []);
  for (const n of CLERK_SKILL_NAMES) assert.doesNotMatch(skillText(n), /\bopen\.\w+/, `${n}: lists are fetched by key, not read off open`);
  // Only the main agent has pk_round_state: a lane's skill names no list.
  for (const kind of LANE_KINDS) assert.doesNotMatch(laneSkill(kind), /pk_round_state/, `${kind}: a lane is not offered pk_round_state`);
});

// ───────────────────────── CM (E151): the program carries the lists and the checks; the skills keep the judgements ─────────────────────────

test('the skills are shorter than before CM, and none grew', () => {
  // Bytes before CM (app 09f304e), by skill: the duties the program took over left the text. CQ (D104) then wrote the
  // records-lead rule into every placement section (the pointers, the program's Inferred placements, the recorded reason),
  // which grew those skills again: the bound is the size after D104, so nothing grows past it unnoticed. CS told the
  // spot-check in two clauses that its placement targets come from earlier rounds too (158 bytes). CU (D105) wrote the
  // form of a note the owner reads into the two skills that write and correct notes — the first sentence, the background
  // in plain words, the options of a decision, no internal identifiers (the owner: 「这个可读性太差了。」): 856 bytes in the
  // synthesis, 538 in the spot-check. What the program checks (the ids, the question, the options) costs them one clause.
  const before: Record<string, number> = {
    coverage: 5838, 'cross-check': 15_605, 'deepen-dispatch': 11457, 'lane-follow-up': 10_058, 'lane-plan': 13691, 'lane-slot': 16126,
    'lane-topic': 15759, orientation: 25543, reconcile: 12_899, 'skeleton-dispatch': 6188, 'spot-check': 6_866, synthesis: 7_866,
  };
  const now = Object.fromEntries(CLERK_SKILL_NAMES.map((n) => [n, Buffer.byteLength(skillText(n), 'utf8')]));
  for (const n of CLERK_SKILL_NAMES) assert.ok(now[n]! < before[n]!, `${n}: ${now[n]} bytes, ${before[n]} before`);
  const total = Object.values(now).reduce((a, b) => a + b, 0);
  // Before CM the twelve were 143873 bytes together; after CM under 85% of that; D104 added about 11K of placement text,
  // D105 the note form (1394 bytes).
  assert.ok(total < 143_873 * 0.85 + 12_000 + 1_400, `the twelve skills together: ${total} bytes, 143873 before CM`);
});

test('links: the cross-check settles the suspect ones only; a lane reads the program’s check and never works around it', () => {
  const cross = stageSkill('cross-check');
  assert.match(cross, /Links: the suspect ones only/);
  assert.match(cross, /pk_round_state\(\{ list: "links" \}\)` lists the suspect ones/);
  assert.match(cross, /Never confirm a link whose original you did not open/);
  assert.doesNotMatch(cross, /Confirm or reject every link/);
  for (const kind of LANE_KINDS) {
    assert.match(laneSkill(kind), /lane-checked, or suspect with why/, `${kind}: the tool's result says which`);
    assert.match(laneSkill(kind), /Never work around it/, `${kind}`);
  }
  assert.match(spotCheckSkill(), /wrongKind/);
  assert.match(spotCheckSkill(), /timing[\s\S]{0,200}substance|substance[\s\S]{0,200}timing/);
  assert.match(spotCheckSkill(), /The program recomputed the candidates just before you started/);
});

test('the owner’s lines go to the lane with the Owner’s words slot; the main agent writes as rules what that lane reported', () => {
  const rule = 'Write as rules the lines the Owner\'s words lane reported under "Lines that set a working rule": `pk_write_rule`, basis Explicit, the owner\'s own words as the excerpt, the session segment as the source.';
  for (const stage of ['orientation', 'reconcile', 'cross-check'] as const) assert.equal(stageSkill(stage).split(rule).length - 1, 1, `${stage}: the sentence, once`);
  assert.match(stageSkill('orientation'), /Give the slot `reference:Owner's words` to a lane/);
  assert.match(stageSkill('skeleton'), /reference:Owner's words/);
  assert.match(stageSkill('dig'), /reference:Owner's words/);
  for (const kind of LANE_KINDS) {
    const body = laneSkill(kind);
    assert.match(body, /\*\*Lines that set a working rule\*\*/, `${kind}: where the main agent finds the rules`);
    assert.match(body, /\*\*Lines that name generations\*\*/, `${kind}`);
    assert.match(body, /label is a reading, never a filter/, `${kind}: a Chat label drops no line`);
  }
  for (const kind of ['slot', 'topic'] as const) {
    assert.match(laneSkill(kind), /A line about what the product is becomes an Owner's words item/);
    assert.match(laneSkill(kind), /Other people's words are not the owner's/);
    assert.match(laneSkill(kind), /Never drop a line that names generations or versions because it was labelled Chat/);
  }
});

test('generations: the candidates get a verdict, every item a destination by id or by the project’s own number', () => {
  const orientation = stageSkill('orientation');
  assert.match(orientation, /Accept or reject each document set:\*\* `pk_generation_candidate\(/);
  assert.match(orientation, /Read those owner's lines before you count the generations/);
  assert.match(orientation, /An earlier version of the current contracts\*\*[^\n]*whether it counts as a generation is yours to judge/, 'not decided in the skill either way');
  for (const stage of ['reconcile', 'cross-check'] as const) {
    assert.match(stageSkill(stage), /pk_round_state\(\{ list: "generationCandidates" \}\)/, `${stage}: a set still waiting gets its verdict`);
    assert.match(stageSkill(stage), /replacedBy: "T-04"/, `${stage}: the project's own number names what replaced it`);
    assert.match(stageSkill(stage), /withoutDestination/);
  }
  assert.match(stageSkill('cross-check'), /This is your duty here, whatever the lanes left/);
});

test('placement: the foundation is an Area, designs are cut where a section serves one area, a Product-only decision is placed by the program’s trace or kept with its reason', () => {
  const orientation = stageSkill('orientation');
  assert.match(orientation, /A cross-cutting foundation that the project's own documents treat as a peer of its modules is an Area too[^\n]*`foundation: true`/);
  assert.match(orientation, /Conventions that apply to every module and own no work[^\n]*are not an Area: they stay in the cross-cutting ring/);
  assert.match(orientation, /One Design per Spec section at the level where it serves one area, usually `###`/);
  assert.match(orientation, /Never tell a lane to cut designs by chapter/);
  assert.match(laneSkill('slot'), /Never one Design per chapter/);
  for (const stage of ['reconcile', 'cross-check'] as const) {
    const body = stageSkill(stage);
    assert.match(body, /pk_round_state\(\{ list: "traceable" \}\)/, `${stage}: the program traces them`);
    assert.match(body, /Place by the suggestion, or say why not/, `${stage}`);
    assert.match(body, /trial or execution arrangement (?:goes to|refines) the plan it shapes/, `${stage}`);
    assert.match(body, /is an Area, not the whole product/, `${stage}`);
    assert.match(body, /pk_write_reference\(\{ id, wholeProductWhy \}\)/, `${stage}: the whole product, with its reason`);
    assert.match(body, /pk_place_range\(\{ numbers: "D3–D18", to: "M2" \}\)/, `${stage}: a run in one call (a neutral example, D104)`);
    assert.match(body, /placedAgain/, `${stage}: a new Area places again what names it`);
  }
  assert.match(stageSkill('cross-check'), /"It is a trial arrangement" and "it is a model choice" are not whole-product reasons/);
  assert.match(stageSkill('cross-check'), /An earlier generation's decisions go into their generation/);
  assert.match(stageSkill('dig'), /reference:Design/, 'a deepening lane may hold the Design slot when asked to');
});

test('an absence claim names the later tickets it read for the same contract — reading, not a number search', () => {
  assert.match(stageSkill('cross-check'), /such a claim must name the later tickets it read for the same contract or object\. That means reading, not a number search/);
  assert.match(synthesisSkill(), /names? the later tickets (?:it|you) read/);
  for (const kind of ['plan', 'topic', 'follow-up'] as const) {
    assert.match(laneSkill(kind), /names the later tickets you read for the same contract/, `${kind}`);
    assert.match(laneSkill(kind), /`T-25-T-31` names T-28/, `${kind}: a range names its members (a neutral example, D104)`);
  }
  assert.match(spotCheckSkill(), /Read an absence claim against the later tickets of the same contract/);
  assert.match(laneSkill('follow-up'), /Read only what the coverage check lists/);
});

// ───────────────────────── every tool a skill names exists and is offered ─────────────────────────

/** Every pk_* tool the program defines, read from its sources (the clerk, stage, lane, ledger and keeper tools). */
function definedTools(): Set<string> {
  const names = new Set<string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) for (const m of readFileSync(p, 'utf8').matchAll(/name: '(pk_[a-z_]+)'/g)) names.add(m[1]!);
    }
  };
  walk(join(appRoot, 'src'));
  return names;
}
/** The tools the W0 contract (build plan §6) names, which other D99 items build. */
// ───────────────────────── CU (D105): the form of a note the owner reads ─────────────────────────

test('the synthesis writes a note in the form the owner reads, and the spot-check corrects one back into it: first sentence, background in plain words, options, no internal identifiers — and no project’s names', () => {
  const s = synthesisSkill();
  assert.match(s, /\*\*The owner reads a note from the top\*\*/);
  assert.match(s, /\*\*First sentence\*\* \(`preview`; the title says the same\): what the owner is asked to decide, as one question/);
  assert.match(s, /\*\*Then the background, in plain words\*\*: what happened, why it comes up now, what it affects/);
  assert.match(s, /Say what a numbered thing is before you use its number; a run of numbers is not a sentence/);
  assert.match(s, /\*\*For a decision, `options`\*\*: each choice with what follows from it, leaving it alone included/);
  assert.match(s, /No store ids, no lane names, no sections of a lane's report or brief: the evidence goes in `sourceIds`, the mount and `looked`/);
  assert.match(s, /The writer refuses the rest\. The Result is read the same way\./);
  const c = spotCheckSkill();
  assert.match(c, /\*\*A note is read by the owner, and so is the Result\.\*\*/);
  assert.match(c, /each numbered thing said before its number, no run of numbers as a sentence; for a decision, `options`, each with what follows/);
  assert.match(c, /A current note that does not read this way, rewrite \(`pk_write_note`\): the form is corrected, and its claim is judged as before/);
  // The method is any project's: the note that set it off, its numbers and its ids are not in the skills.
  for (const body of [s, c]) assert.doesNotMatch(body, /\bD13\b|\bD20\b|ADR|ContextKeeper|CKC-\d|\b(?:mark|ref|note|rule)_[0-9a-z]{8,}/);
});

const CONTRACT_TOOLS = ['pk_stage', 'pk_round_state', 'pk_send_lanes', 'pk_lanes', 'pk_coverage_check', 'pk_account_material', 'pk_fill_from_table', 'pk_fill_from_headings', 'pk_record_looked'];
/** A Follow up round's cross-check writes the net changes and judges what they reach (roles.ts FOLLOW_UP_WRITES). */
const FOLLOW_UP_CROSS_CHECK = ['pk_write_change', 'pk_judge_object', 'pk_set_propagation', 'pk_set_propagations', 'pk_round_pending'];

test('every pk_* tool a skill names exists (the contract’s new tools by name)', () => {
  const known = new Set([...definedTools(), ...CONTRACT_TOOLS]);
  for (const name of CLERK_SKILL_NAMES) {
    const unknown = [...toolsNamed(skillText(name))].filter((t) => !known.has(t));
    assert.deepEqual(unknown, [], `${name} names tools that do not exist`);
  }
});

test('every writer a skill names is offered to the job that reads it, in that stage or with those slots', () => {
  const writers = new Set<string>([
    ...Object.values(STAGE_WRITERS).flat(), ...Object.values(SLOT_WRITERS).flat(), ...LANE_ALWAYS, ...MAIN_ALWAYS,
    ...Object.keys(CLERK_WRITER_STEPS), ...Object.values(STEP_WRITES).flatMap((s) => [...s]), ...FOLLOW_UP_CROSS_CHECK,
  ]);
  const check = (name: string, offered: Iterable<string>) => {
    const ok = new Set(offered);
    const stray = [...toolsNamed(skillText(name))].filter((t) => writers.has(t) && !ok.has(t));
    assert.deepEqual(stray, [], `${name} names writers its job is not offered there`);
  };
  for (const stage of STAGES) check((STAGE_SKILLS as Readonly<Record<string, string>>)[stage]!, [...MAIN_ALWAYS, ...STAGE_WRITERS[stage], ...(stage === 'cross-check' ? FOLLOW_UP_CROSS_CHECK : [])]);
  // D103: the synthesis job is offered what its skill names — the synthesis' writers and where the round stands.
  check(SYNTHESIS_SKILL, STEP_WRITES.synthesis!);
  for (const t of ['pk_write_note', 'pk_close_note', 'pk_confirm_note', 'pk_tag_six', 'pk_suggest_sendback', 'pk_write_area', 'pk_write_round_doc', 'pk_round_state']) assert.ok(toolsNamed(skillText(SYNTHESIS_SKILL)).has(t), `the synthesis skill names ${t}`);
  for (const kind of LANE_KINDS) check(LANE_SKILLS[kind], [...Object.values(SLOT_WRITERS).flat(), ...LANE_ALWAYS]);
  check(SPOT_CHECK_SKILL, STEP_WRITES['spot-check']!);
  // And the tools each dispatching stage relies on are there.
  for (const stage of ['skeleton', 'dig', 'coverage'] as const) assert.ok(STAGE_WRITERS[stage].includes('pk_send_lanes'));
});

// ───────────────────────── the install's folder, not the project's ─────────────────────────

test('the skills folder resolves from the install, whatever the working directory', () => {
  const expected = pathKey(join(appRoot, 'skills', 'clerk'));
  assert.equal(pathKey(clerkSkillsDir()), expected);
  const before = process.cwd();
  const elsewhere = mkdtempSync(join(tmpdir(), 'pk-skills-cwd-'));
  try {
    process.chdir(elsewhere);
    assert.equal(pathKey(clerkSkillsDir()), expected, 'the cwd does not move it');
    assert.ok(existsSync(clerkSkillFile('orientation')));
  } finally { process.chdir(before); }
});

test('isClerkSkillPath: the install’s skill files, not a project’s copy of them', () => {
  assert.equal(isClerkSkillPath(clerkSkillFile('lane-plan')), true);
  assert.equal(isClerkSkillPath(clerkSkillsDir()), true);
  assert.equal(isClerkSkillPath(clerkSkillFile('lane-plan').toUpperCase()), process.platform === 'win32' || process.platform === 'darwin', 'case-folded where the system’s file system folds it: Windows and macOS (util/paths.ts `foldForSystem`)');
  assert.equal(isClerkSkillPath('skills/clerk/lane-plan/SKILL.md'), false, 'a relative path with no cwd is project material');
  assert.equal(isClerkSkillPath('skills/clerk/lane-plan/SKILL.md', appRoot), true, 'taken against the install it is the install’s');
  assert.equal(isClerkSkillPath('app/skills/clerk/lane-plan/SKILL.md', mkdtempSync(join(tmpdir(), 'pk-project-'))), false, 'a project’s own copy is its material');
  assert.equal(isClerkSkillPath(join(appRoot, 'src', 'keeper', 'organize', 'skills.ts')), false);
  assert.equal(isClerkSkillPath(join(appRoot, 'skills', 'clerk-other', 'x.md')), false, 'a sibling folder is not it');
  assert.equal(isClerkSkillPath(''), false);
});

// ───────────────────────── pi loads them for the clerk round's jobs; the boundary lets those read them ─────────────────────────

test('pi loads the clerk skills for main, lane, synthesis and spot-check jobs only, and the read boundary opens them to those jobs', async () => {
  assert.deepEqual(clerkSkillPathsFor('main'), [clerkSkillsDir()]);
  assert.deepEqual(clerkSkillPathsFor('synthesis'), [clerkSkillsDir()]);
  assert.deepEqual(clerkSkillPathsFor('lane'), [clerkSkillsDir()]);
  assert.deepEqual(clerkSkillPathsFor('spot-check'), [clerkSkillsDir()]);
  for (const other of [undefined, null, 'orientation', 'session-drafts', 'dig', 'ledger']) assert.deepEqual(clerkSkillPathsFor(other), []);

  const t = mkdtempSync(join(tmpdir(), 'pk-skills-boundary-'));
  const project = join(t, 'work', 'project');
  const agentDir = join(t, 'agent');
  const storeDir = join(t, 'pk-home', 'projects', 'proj-1');
  for (const d of [project, agentDir, storeDir]) mkdirSync(d, { recursive: true });
  const store = { dir: storeDir, sources: { all: () => [] } } as unknown as ProjectStore;
  const projectRecord = { id: 'proj-1', name: 'Demo', locations: [project], scope: [], toolchain: [] } as unknown as Project;

  const boundaryFor = async (stepKind: string | undefined) => {
    const loader = new DefaultResourceLoader({ cwd: project, agentDir, additionalSkillPaths: clerkSkillPathsFor(stepKind), noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const deps = { project: projectRecord, store, agentDir, settingsManager: {} as unknown as SettingsManager, resolveLoader: () => loader, home: join(t, 'home'), projectKeeperHome: join(t, 'pk-home') };
    const { roots, files, refused } = allowedRoots(deps);
    return { loader, boundary: makeBoundary({ roots, files }), refused };
  };

  const main = await boundaryFor('main');
  const loaded = main.loader.getSkills().skills.map((s) => s.name);
  for (const name of CLERK_SKILL_NAMES) assert.ok(loaded.includes(name), `pi loaded ${name}`);
  assert.deepEqual(main.loader.getSkills().diagnostics, []);
  assert.deepEqual(main.refused, [], 'no skill folder refused as too broad');
  for (const name of CLERK_SKILL_NAMES) assert.equal(main.boundary.decide(clerkSkillFile(name), project).ok, true, `${name} is readable`);

  const other = await boundaryFor(undefined);
  assert.ok(!other.loader.getSkills().skills.some((s) => CLERK_SKILL_NAMES.includes(s.name)), 'no clerk skill for other jobs');
  assert.equal(other.boundary.decide(clerkSkillFile('orientation'), project).ok, false, 'other jobs do not reach the install');
});
