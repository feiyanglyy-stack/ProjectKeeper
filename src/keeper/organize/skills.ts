/**
 * The clerk method's skills (D99; Spec §3.3 "每个阶段一份 skill"): the method is given to the Keeper's agent as one pi
 * SKILL.md per stage of the main agent, per kind of lane, one for the synthesis (D103: a job of its own, whose prompt
 * starts with it) and one for the independent spot-check — not as tasks the program cuts. They live in the install's `skills/clerk/<name>/SKILL.md`, in pi's format (frontmatter `name` and
 * `description`), and reach an agent two ways (E148 D-b): pi loads the folder natively for the clerk round's jobs
 * (runtime.ts `additionalSkillPaths`) and lists them in its system prompt, and the text itself is put in front of the
 * agent — `pk_stage` returns the stage's skill, and a lane's prompt starts with its lane's skill — since GLM does not
 * always open a skill file by itself.
 *
 * The folder is resolved from the running install, relative to this module's own file, never from the project's
 * working directory: ProjectKeeper's own skills folder is also project material when the Keeper organizes its own
 * repository, and the resident install is a separate checkout (build plan §4 "自指"). Reads of this folder are left out of what a
 * round counts as read (`isClerkSkillPath`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { stripFrontmatter } from '@earendil-works/pi-coding-agent';
import type { ClerkStage, LaneKind } from '../../model/k-types.ts';
import { isWithin, normalizePath } from '../../util/paths.ts';

/** The skill of each stage of the main agent's session (D103: the synthesis is no stage of it; `SYNTHESIS_SKILL`). */
export const STAGE_SKILLS: Readonly<Record<Exclude<ClerkStage, 'synthesis'>, string>> = {
  orientation: 'orientation',
  skeleton: 'skeleton-dispatch',
  reconcile: 'reconcile',
  dig: 'deepen-dispatch',
  coverage: 'coverage',
  'cross-check': 'cross-check',
};

/** The synthesis' skill (D103): the head of the synthesis job's prompt. */
export const SYNTHESIS_SKILL = 'synthesis';

/** The skill of each kind of lane. */
export const LANE_SKILLS: Readonly<Record<LaneKind, string>> = {
  slot: 'lane-slot',
  plan: 'lane-plan',
  topic: 'lane-topic',
  'follow-up': 'lane-follow-up',
};

/** The independent spot-check's skill. */
export const SPOT_CHECK_SKILL = 'spot-check';

/** Every clerk skill, by folder name. */
export const CLERK_SKILL_NAMES: readonly string[] = [...Object.values(STAGE_SKILLS), SYNTHESIS_SKILL, ...Object.values(LANE_SKILLS), SPOT_CHECK_SKILL];

/** The folder of the clerk method's skills in the running install (`<install>/skills/clerk`). */
export function clerkSkillsDir(): string {
  return normalizePath(fileURLToPath(new URL('../../../skills/clerk/', import.meta.url)));
}

/** The SKILL.md of one clerk skill in the running install. */
export function clerkSkillFile(name: string): string {
  return join(clerkSkillsDir(), name, 'SKILL.md');
}

const bodies = new Map<string, string>();

/** A skill's body, without its frontmatter. Read once per process: the install does not change under a running Keeper. */
function skillBody(name: string): string {
  let body = bodies.get(name);
  if (body === undefined) {
    const file = clerkSkillFile(name);
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch (e) { throw new Error(`the clerk skill "${name}" is missing from the install (${file}): ${(e as Error).message}`); }
    body = stripFrontmatter(raw).trim();
    bodies.set(name, body);
  }
  return body;
}

/** The skill of a stage of the main agent's session, without frontmatter (what `pk_stage` returns). */
export function stageSkill(stage: ClerkStage): string {
  const name = (STAGE_SKILLS as Readonly<Record<string, string>>)[stage];
  if (!name) throw new Error(`no clerk skill for the stage "${stage}"`);
  return skillBody(name);
}

/** The synthesis' skill, without frontmatter (the head of the synthesis job's prompt, D103). */
export function synthesisSkill(): string {
  return skillBody(SYNTHESIS_SKILL);
}

/** The skill of a kind of lane, without frontmatter (the head of a lane's prompt). */
export function laneSkill(kind: LaneKind): string {
  const name = LANE_SKILLS[kind];
  if (!name) throw new Error(`no clerk skill for the lane kind "${kind}"`);
  return skillBody(name);
}

/** The independent spot-check's skill, without frontmatter. */
export function spotCheckSkill(): string {
  return skillBody(SPOT_CHECK_SKILL);
}

/** The job kinds of a clerk round that pi loads the clerk skills for (D99, D103): the main agent, its lanes, the synthesis, the spot-check. */
export const SKILLED_STEP_KINDS: ReadonlySet<string> = new Set(['main', 'lane', 'synthesis', 'spot-check']);

/** The extra skill paths pi's resource loader gets for a job: the clerk skills folder for a clerk round's jobs, else none. */
export function clerkSkillPathsFor(stepKind: string | null | undefined): string[] {
  return stepKind && SKILLED_STEP_KINDS.has(stepKind) ? [clerkSkillsDir()] : [];
}

/**
 * Whether a path is in the install's clerk skills folder — an agent reading its own method, not the project's material,
 * so a round's read tally and coverage leave it out (W5, W8). A relative path is taken against `cwd` when given, else
 * it is not the skills folder (the install is never addressed relative to a project).
 */
export function isClerkSkillPath(path: string, cwd?: string): boolean {
  const p = path.trim();
  if (!p) return false;
  if (!isAbsolute(p) && !cwd) return false;
  try { return isWithin(clerkSkillsDir(), isAbsolute(p) ? p : join(cwd!, p)); } catch { return false; }
}
