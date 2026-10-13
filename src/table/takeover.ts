/**
 * `pk takeover`: a takeover by the table in the three steps the trials proved (template/FILLING-IN.md, "Who fills
 * what"; D107). The reader of the owner's words fills `ownerWants` from the session material alone; the reader of the
 * project fills the rest of the table from a copy of the project alone; the main agent sees both, merges them, links
 * each want to what carries it out, and writes where the owner and the project part ways.
 *
 * The two routes are kept apart the way the owner keeps trials apart: by physical separation. Each works in its own
 * folder holding only its material — the session material for the first, a COPY of the project for the second — and
 * neither folder is the live project. All of it is laid out in a work folder in ProjectKeeper's own folder for the
 * project, never inside the project, since the material carries the owner's words and the project may be public.
 *
 * `prepareTakeover` lays the work folder out and writes each step's instructions, so that any agent (Claude Code,
 * Codex, Kimi…) can be run on the three steps by the owner. `runTakeover` also runs them headless with Codex CLI, the
 * way the trials ran them, then checks the merged table, puts it where the table lives and takes it in (import.ts).
 * There is no Claude runner: running a Claude subscription from a third-party tool is against Anthropic's terms, so a
 * Claude Code user runs the three steps from the prepared folders in their own Claude Code.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDir as homeProjectDir } from '../store/paths.ts';
import { git } from '../util/git.ts';
import { canonicalPath, isWithin, pathKey } from '../util/paths.ts';
import { checkOwnerPartFile, checkTableFile, readSessionMaterial, SCHEMA_FILE, type TableProblem } from './check.ts';
import { importTable, type ImportResult } from './import.ts';
import { withTableProject } from './project-home.ts';
import { exportSessionMaterial, JSONL_FILE, MARKDOWN_FILE } from './sessions.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', '..');
const TEMPLATE_DIR = dirname(SCHEMA_FILE);

export const OWNER_FOLDER = 'owner';
export const READER_FOLDER = 'project-reader';
export const INSTRUCTIONS_FILE = 'instructions.md';
export const MAIN_INSTRUCTIONS_FILE = 'main-instructions.md';
export const OWNER_PART_FILE = 'owner-part.json';
/** The merged table the main agent writes at the top of the work folder; route 2's own table stays as it was written. */
export const MAIN_TABLE_FILE = 'project.json';
/** Where a headless run keeps each step's events, last message and times; outside both routes' folders. */
export const RUNS_FOLDER = 'runs';

/** Where the table lives once taken in: in the project (a private project may) or in ProjectKeeper's own folder. */
export type TableIn = 'home' | 'project';
export type StepName = 'owner' | 'project-reader' | 'main';

export interface TakeoverOptions {
  /** The project folder. */
  readonly projectDir: string;
  /** The ProjectKeeper home; by default the user's. */
  readonly home?: string;
  /** The project's name when it is added; by default the folder's. */
  readonly name?: string;
  /** Where the taken-in table lives; by default `home`, safe for a public project (D107). */
  readonly tableIn?: TableIn;
  /** The moment the work folder is named after and the project copy is dated by; now by default. */
  readonly now?: Date;
}

export interface TakeoverRepo {
  /** Relative to the project folder, with forward slashes; "." for the folder itself. */
  readonly path: string;
  readonly commit: string;
}

export interface TakeoverStep {
  readonly name: StepName;
  /** The folder the agent works in, and the only one it is given. */
  readonly folder: string;
  readonly instructions: string;
  /** What the step writes. */
  readonly output: string;
}

export interface PreparedTakeover {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectDir: string;
  readonly home: string;
  readonly added: boolean;
  readonly workDir: string;
  readonly steps: { readonly owner: TakeoverStep; readonly reader: TakeoverStep; readonly main: TakeoverStep };
  /** The session material in the owner folder; `--sessions` for the checks and the import. */
  readonly sessionsFile: string;
  /** The copy of the project route 2 reads, and the folder its table's paths are relative to. */
  readonly readerProject: string;
  readonly repos: readonly TakeoverRepo[];
  readonly ownerMessages: number;
  readonly sessions: number;
  /** Entries of the project the copy left out (what git ignores, node_modules, links), relative to the project. */
  readonly skipped: readonly string[];
  readonly tableIn: TableIn;
  /** Where the table goes when it is taken in. */
  readonly destination: string;
  /** The exact command that runs `pk`, as the instructions give it. */
  readonly pk: string;
  /** The command that takes the table in once it stands at `destination`. */
  readonly importCommand: string;
  readonly warnings: readonly string[];
}

// ───────────────────────── the project copy ─────────────────────────

const slash = (p: string): string => p.split('\\').join('/');

/**
 * Copy the project for route 2, and find its repositories on the way: every folder holding `.git` is one, recorded with
 * its HEAD. Each repository's `.git` is copied whole, so the reader has the history. Left out:
 * - what a repository ignores (`git ls-files --others --ignored --directory`): dependencies, build output, and local
 *   material that is not the project as it is kept — which can hold the owner's words (exported sessions, trial
 *   folders) and so would break the separation of the two routes; a folder git ignores that is itself a repository is
 *   still copied;
 * - every `node_modules`, ignored or not;
 * - `projectkeeper/` at the top, an earlier table, which may quote the owner (the reader writes its own there);
 * - symbolic links, which may lead out of the project;
 * - the folders in `avoid` (a home or a work folder that lies inside the project).
 */
export function copyProject(src: string, dest: string, avoid: readonly string[] = []): { repos: TakeoverRepo[]; skipped: string[]; warnings: string[] } {
  const repos: TakeoverRepo[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const ignored = new Set<string>();
  const avoided = new Set(avoid.map((a) => pathKey(a)));
  const walk = (rel: string) => {
    const dir = rel ? join(src, rel) : src;
    mkdirSync(rel ? join(dest, rel) : dest, { recursive: true });
    if (existsSync(join(dir, '.git'))) {
      const head = git(dir, ['rev-parse', '--short', 'HEAD']);
      if (head.ok && head.out.trim()) repos.push({ path: rel || '.', commit: head.out.trim() });
      else warnings.push(`${rel || 'The project folder'} is a git repository with no commit; the table cannot stand on it.`);
      const listed = git(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], 60_000);
      if (listed.ok) for (const entry of listed.out.split('\0')) if (entry) ignored.add(pathKey(resolve(dir, entry.replace(/\/$/, ''))));
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const from = join(dir, entry.name);
      const relEntry = rel ? `${rel}/${entry.name}` : entry.name;
      const to = join(dest, relEntry);
      if (entry.isSymbolicLink()) { skipped.push(relEntry); continue; }
      if (entry.isDirectory()) {
        if (entry.name === '.git') { cpSync(from, to, { recursive: true }); continue; }
        const isRepo = existsSync(join(from, '.git'));
        if (entry.name === 'node_modules' || avoided.has(pathKey(from)) || (!rel && entry.name === 'projectkeeper')
          || (ignored.has(pathKey(from)) && !isRepo)) { skipped.push(`${relEntry}/`); continue; }
        walk(relEntry);
      } else if (entry.isFile()) {
        if (ignored.has(pathKey(from))) { skipped.push(relEntry); continue; }
        copyFileSync(from, to);
      }
    }
  };
  walk('');
  return { repos, skipped, warnings };
}

// ───────────────────────── the instructions ─────────────────────────
// The trials' instructions, in the owner's language and as the owner read them, with the project filled in.

interface InstructionFacts {
  readonly projectName: string;
  readonly date: string;
  readonly repos: readonly TakeoverRepo[];
  readonly ownerMessages: number;
  readonly sessions: number;
  readonly pk: string;
  readonly workFolderName: string;
}

const where = (): string => slash(appRoot);

export function ownerInstructions(f: InstructionFacts): string {
  return `# 任务：从 owner 的原话里，填 ProjectKeeper 表的 \`ownerWants\`

这个文件夹里有：
- \`${MARKDOWN_FILE}\`：软件项目「${f.projectName}」的 agent 会话里，owner 说的全部 ${f.ownerMessages} 句话（来自 ${f.sessions} 个会话），按时间排。每句前面附着它回应的那条 agent 最后输出（只有正文，没有 thinking 和工具调用）。每条都标了会话名和第几句。
- \`${JSONL_FILE}\`：同一份材料，给检查命令用。
- \`template/FILLING-IN.md\`：ProjectKeeper 表的填写说明；\`template/projectkeeper.schema.json\` 是格式；\`template/examples/papertrail.json\` 是一份填好的样例。

你是「谁填什么」里的第一步：**只读原话这一路**。

## 要做的

1. 读 \`template/FILLING-IN.md\`，特别是 \`ownerWants\`、\`notes\`、Sources 三节。
2. 读完全部会话材料。怎么读、按什么顺序读，由你定。
3. 写 \`${OWNER_PART_FILE}\`，只有两个字段：

   \`\`\`json
   { "ownerWants": [ … ], "notes": [ … ] }
   \`\`\`

   - \`ownerWants\` 照填写说明写。
     - \`said\` 里的每句都要带 \`quote\`，并且逐字照抄。
     - owner 回答「对」「可以」这类短句时，认可的是前一条 agent 输出里的哪一部分，写进 \`approvedProposal\`，\`source\` 指向那条 agent 消息。
     - \`reflectedIn\` 一律写成空数组 \`[]\`。项目这一边由别人读，最后由 main agent 来连。
   - \`notes\` 只写你从原话里看出来、需要 owner 注意的事。比如 owner 前后矛盾、没有定论、说了又没再提。
     - \`by\` 写 \`"Owner's words"\`。
     - \`on\` 只能指向你自己写的 \`ownerWants\` 编号。
4. 运行下面这条命令，改到它说 \`no problems\` 为止：

   \`\`\`
   ${f.pk} check --owner-part ${OWNER_PART_FILE} --sessions ${JSONL_FILE}
   \`\`\`

## 边界

- 只在这个文件夹里活动。不要打开这个文件夹外面的任何东西；材料里提到的路径也不要去看。检查命令会读 \`${where()}\` 里的格式程序，这是允许的。
- 没有网络。

做完后，最后一条消息用三五行说：多少件、其中几件已被取代、几件没有定论、写了几条 note。
`;
}

const repoLine = (r: TakeoverRepo): string => (r.path === '.' ? `- \`project/\` 本身，HEAD 是 \`${r.commit}\`；` : `- \`project/${r.path}/\`，HEAD 是 \`${r.commit}\`；`);

export function readerInstructions(f: InstructionFacts): string {
  const asOf = `[${f.repos.map((r) => `{ "path": ${JSON.stringify(r.path)}, "commit": "${r.commit}" }`).join(', ')}]`;
  const lines = f.repos.map(repoLine);
  if (lines.length) lines[lines.length - 1] = lines[lines.length - 1]!.replace(/；$/, '。');
  return `# 任务：读一个项目，填 ProjectKeeper 表

\`project/\` 是软件项目「${f.projectName}」的一份副本，时间停在 ${f.date}。里面有${f.repos.length === 1 ? '一' : ` ${f.repos.length} `}个 git 仓库：
${lines.join('\n')}

\`template/FILLING-IN.md\` 是 ProjectKeeper 表的填写说明，\`template/projectkeeper.schema.json\` 是格式，\`template/examples/papertrail.json\` 是一份填好的样例。

你是「谁填什么」里的第二步：**只读项目这一路**。

## 要做的

1. 读 \`template/FILLING-IN.md\`。
2. 读懂这个项目。读什么、按什么顺序、读多深，由你定：文档、git 历史、代码都可以用，shell 随便用。
3. 把表写到 \`project/projectkeeper/project.json\`。
   - \`project.asOf.repos\` 写 \`${asOf}\`。
   - \`ownerWants\` 写空数组 \`[]\`。owner 的原话由另一路从会话里读，最后由 main agent 合进来。
   - 其余各部分照填写说明写。文档里逐字引用 owner 的话，可以作为出处的 \`quote\` 用。
   - \`notes\` 的 \`by\` 写 \`"Project"\`。
4. 运行下面这条命令，改到它说 \`no problems\` 为止：

   \`\`\`
   ${f.pk} check project/projectkeeper/project.json --project project
   \`\`\`

## 边界

- 只在这个文件夹里活动，不要打开它外面的任何东西。例外只有上面那条检查命令，它会读 \`${where()}\` 里的检查程序。
- 文档里提到的、这个文件夹外面的路径不要去看。
- 除了 \`project/projectkeeper/\` 这个新文件夹，\`project/\` 里的东西一律不要改。
- 没有网络。

做完后，最后一条消息用三五行说：各部分各有多少条，以及你认为这个项目现在最不对劲的三件事。
`;
}

export function mainInstructions(f: InstructionFacts): string {
  return `# 任务：把两路合成一张 ProjectKeeper 表

你是「谁填什么」里的第三步：**main agent**。前两步已经各自做完：
- \`${OWNER_FOLDER}/${OWNER_PART_FILE}\`：一个 agent 只读 owner 的会话原话（\`${OWNER_FOLDER}/${MARKDOWN_FILE}\`），填好的 \`ownerWants\` 和它的 notes。
- \`${READER_FOLDER}/project/projectkeeper/project.json\`：另一个 agent 只读项目（\`${READER_FOLDER}/project/\`，时间停在 ${f.date}），填好的其余各部分和它的 notes，\`ownerWants\` 是空的。

两路互相没看过对方。填写说明在 \`${READER_FOLDER}/template/FILLING-IN.md\`。

## 要做的

1. 读填写说明的「Who fills what」一节，再读两路的产出。需要核实时，可以回到会话材料和项目里查。
2. 以 \`${READER_FOLDER}/project/projectkeeper/project.json\` 为底，把 \`${OWNER_PART_FILE}\` 的 \`ownerWants\` 和它的 notes 合进去，写成这个文件夹顶层的 \`${MAIN_TABLE_FILE}\`。两路的原文件都不要改。两路的 notes 原样保留，可以修正明显的错，不删。
3. 给每件 \`ownerWants\` 填 \`reflectedIn\`：项目里哪些目标、区域、需求、设计、决定、工作项在落实它。
4. 两边对不上的地方，写 note：\`by\` 写 \`"Main agent"\`，\`kind\` 写 \`"Owner and project differ"\`。比如：
   - owner 要的、项目里没有；
   - 项目里有的、owner 没要过或已经推翻了；
   - owner 已经答过、文档里还写着待定；
   - 项目里写成现行的、owner 后来改口了。

   每条 note 的 \`on\` 同时指向那件 want 和项目里的对象；\`sources\` 两边都引。
5. 运行下面这条命令，改到它说 \`no problems\` 为止：

   \`\`\`
   ${f.pk} check ${MAIN_TABLE_FILE} --project ${READER_FOLDER}/project --sessions ${OWNER_FOLDER}/${JSONL_FILE}
   \`\`\`

## 边界

- 只在这个文件夹（\`${f.workFolderName}/\`）里活动，不要打开它外面的任何东西。例外只有上面那条检查命令。
- 除了 \`${MAIN_TABLE_FILE}\`，其他文件一律不要改。
- 没有网络。

做完后，最后一条消息用三五行说：合并后各部分各有多少条、你写了几条「对不上」的 note，以及你认为 owner 最该先看的三条。
`;
}

// ───────────────────────── prepare ─────────────────────────

const quoteArg = (a: string): string => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
/** `pk` as the instructions give it: this installation's own entry, run by node, so it works wherever the agent is. */
export const pkCommand = (): string => `node ${quoteArg(slash(join(appRoot, 'bin', 'pk.mjs')))}`;

function stamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

/**
 * Lay out the work folder: `owner/` with the session material, `project-reader/` with a copy of the project, a copy of
 * the template in each, each route's instructions in its folder and the main agent's at the top. Nothing is written
 * into the project. The project is found by its folder or added and read in, as `pk sessions` does.
 */
export async function prepareTakeover(options: TakeoverOptions): Promise<PreparedTakeover> {
  const projectDir = canonicalPath(options.projectDir);
  const tableIn = options.tableIn ?? 'home';
  const now = options.now ?? new Date();
  return withTableProject({ projectDir, home: options.home, name: options.name ?? basename(projectDir) }, async ({ app, project, home, added, warnings }) => {
    const ledger = app.ledger.ledger(project.id);
    if (!ledger) throw new Error(`The ledger of ${project.name} could not be built, so there is no session material for the owner's words.${warnings.length ? ` ${warnings.join(' ')}` : ''}`);
    const tableDir = join(homeProjectDir(project.id, home), 'table');
    let workDir = join(tableDir, `takeover-${stamp(now)}`);
    for (let n = 2; existsSync(workDir); n++) workDir = join(tableDir, `takeover-${stamp(now)}-${n}`);
    // The home may lie inside the project; the work folder never does.
    const inside = project.locations.find((l) => isWithin(canonicalPath(l), workDir));
    if (inside !== undefined) throw new Error(`${workDir} is inside the project folder ${inside}. The takeover's work folder holds the session material, which carries the owner's words, and the project may be a public repository, so it is laid out only outside the project: point --home at a ProjectKeeper folder outside it (D107).`);

    const ownerDir = join(workDir, OWNER_FOLDER);
    const readerDir = join(workDir, READER_FOLDER);
    const readerProject = join(readerDir, 'project');
    mkdirSync(ownerDir, { recursive: true });
    const material = exportSessionMaterial(ledger, ownerDir);
    const copied = copyProject(projectDir, readerProject, [home, workDir]);
    if (!copied.repos.length) throw new Error(`${projectDir} holds no git repository with a commit. The table stands on the commit each repository was read at (project.asOf), so a takeover by the table needs one.`);
    for (const dir of [ownerDir, readerDir]) cpSync(TEMPLATE_DIR, join(dir, 'template'), { recursive: true });

    const pk = pkCommand();
    const facts: InstructionFacts = {
      projectName: project.name, date: now.toISOString().slice(0, 10), repos: copied.repos,
      ownerMessages: material.ownerMessages, sessions: material.sessions, pk, workFolderName: basename(workDir),
    };
    const ownerFile = join(ownerDir, INSTRUCTIONS_FILE);
    const readerFile = join(readerDir, INSTRUCTIONS_FILE);
    const mainFile = join(workDir, MAIN_INSTRUCTIONS_FILE);
    writeFileSync(ownerFile, ownerInstructions(facts));
    writeFileSync(readerFile, readerInstructions(facts));
    writeFileSync(mainFile, mainInstructions(facts));

    const destination = tableIn === 'project' ? join(projectDir, 'projectkeeper', 'project.json') : join(tableDir, 'project.json');
    const importCommand = [pk, 'import', quoteArg(destination), '--project', quoteArg(projectDir), '--home', quoteArg(home), '--sessions', quoteArg(material.jsonl)].join(' ');
    return {
      projectId: project.id, projectName: project.name, projectDir, home, added, workDir,
      steps: {
        owner: { name: 'owner', folder: ownerDir, instructions: ownerFile, output: join(ownerDir, OWNER_PART_FILE) },
        reader: { name: 'project-reader', folder: readerDir, instructions: readerFile, output: join(readerProject, 'projectkeeper', 'project.json') },
        main: { name: 'main', folder: workDir, instructions: mainFile, output: join(workDir, MAIN_TABLE_FILE) },
      },
      sessionsFile: material.jsonl, readerProject, repos: copied.repos, ownerMessages: material.ownerMessages, sessions: material.sessions,
      skipped: copied.skipped, tableIn, destination, pk, importCommand, warnings: [...warnings, ...copied.warnings],
    };
  });
}

// ───────────────────────── run with Codex ─────────────────────────

export interface RunTakeoverOptions extends TakeoverOptions {
  /** Codex's model; absent, `-m` is left out and Codex uses its configured default. */
  readonly model?: string;
  /** Codex's reasoning effort; `high` by default, as in the trials. */
  readonly effort?: string;
  /** The program standing in for `codex` and its first arguments (tests); `['codex']` by default. */
  readonly agentCommand?: readonly string[];
  /** Progress, one line at a time. */
  readonly log?: (line: string) => void;
}

export interface StepRun {
  readonly step: StepName;
  readonly exitCode: number | null;
  /** The folder holding events.jsonl, stderr.txt, started.txt, ended.txt and last-message.md. */
  readonly logDir: string;
  readonly lastMessage: string | null;
}

export interface TakeoverRun {
  readonly prepared: PreparedTakeover;
  readonly runs: readonly StepRun[];
  /** The step the run stopped after without taking a table in, and why; null when the table was taken in. */
  readonly stopped: { readonly after: StepName | 'check' | 'import'; readonly why: string } | null;
  /** The merged table's problems when it did not check clean (or the import's). */
  readonly problems: readonly TableProblem[];
  /** Problems of a route's own output, reported and passed to the main agent, which holds the whole table to the check. */
  readonly routeProblems: { readonly owner: readonly TableProblem[]; readonly reader: readonly TableProblem[] };
  readonly imported: ImportResult | null;
  /** An earlier table that stood at the destination, kept in the work folder before it was replaced. */
  readonly previousTable: string | null;
}

/** Codex's arguments as the trials ran it: memories off, writing only in the step's folder, events as JSON. */
export function codexArgs(folder: string, lastMessage: string, model: string | undefined, effort: string): string[] {
  return [
    'exec', ...(model ? ['-m', model] : []), '-c', `model_reasoning_effort=${effort}`,
    '--disable', 'memories', '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false',
    '-s', 'workspace-write', '-C', folder, '--skip-git-repo-check', '--json', '-o', lastMessage, '-',
  ];
}

/** A Windows command line for cmd.exe: a `.cmd` shim such as npm's `codex.cmd` runs only through it. */
const cmdArg = (a: string): string => (a === '' || /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
const utcSeconds = (): string => `${new Date().toISOString().slice(0, 19)}Z`;

/** One step, headless: the instructions on stdin, events to events.jsonl, stderr to stderr.txt, the times beside them. */
async function runStep(step: StepName, folder: string, instructions: string, logDir: string, options: RunTakeoverOptions): Promise<StepRun> {
  mkdirSync(logDir, { recursive: true });
  const lastFile = join(logDir, 'last-message.md');
  const [program, ...first] = options.agentCommand ?? ['codex'];
  const args = [...first, ...codexArgs(folder, lastFile, options.model, options.effort ?? 'high')];
  writeFileSync(join(logDir, 'started.txt'), `${utcSeconds()}\n`);
  const viaShell = process.platform === 'win32' && !/\.(exe|com)$/i.test(program!);
  const events = createWriteStream(join(logDir, 'events.jsonl'));
  const stderr = createWriteStream(join(logDir, 'stderr.txt'));
  const exitCode = await new Promise<number | null>((done) => {
    const child = viaShell
      ? spawn([program!, ...args].map(cmdArg).join(' '), { cwd: folder, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(program!, args, { cwd: folder, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.pipe(events);
    child.stderr.pipe(stderr);
    child.on('error', (e) => { stderr.write(`${e.message}\n`); done(null); });
    child.on('close', (code) => done(code));
    child.stdin.on('error', () => undefined);
    child.stdin.end(readFileSync(instructions));
  });
  await Promise.all([new Promise((r) => events.end(r)), new Promise((r) => stderr.end(r))]);
  writeFileSync(join(logDir, 'ended.txt'), `${utcSeconds()}\n`);
  return { step, exitCode, logDir, lastMessage: existsSync(lastFile) ? readFileSync(lastFile, 'utf8') : null };
}

/**
 * Prepare, then run the three steps with Codex: the two routes at once, then the main agent. The merged table is held
 * to the whole check against the project and the session material; when it holds it is put at its destination and
 * taken in, so the project's `takenOverByTable.file` names the destination. When it does not, nothing is taken in and
 * the problems and the work folder are returned.
 */
export async function runTakeover(options: RunTakeoverOptions): Promise<TakeoverRun> {
  const log = options.log ?? (() => undefined);
  const prepared = await prepareTakeover(options);
  const { owner, reader, main } = prepared.steps;
  const runsDir = join(prepared.workDir, RUNS_FOLDER);
  const empty = { owner: [] as TableProblem[], reader: [] as TableProblem[] };
  const result = (rest: Omit<TakeoverRun, 'prepared'>): TakeoverRun => ({ prepared, ...rest });

  log(`Routes 1 and 2 running: ${owner.folder} and ${reader.folder}`);
  const routes = await Promise.all([
    runStep('owner', owner.folder, owner.instructions, join(runsDir, 'owner'), options),
    runStep('project-reader', reader.folder, reader.instructions, join(runsDir, 'project-reader'), options),
  ]);
  for (const r of routes) log(`  ${r.step}: exit ${r.exitCode ?? 'none (did not start)'}`);
  const missing = [owner, reader].filter((s) => !existsSync(s.output));
  if (missing.length) {
    return result({ runs: routes, stopped: { after: missing[0]!.name, why: `${missing.map((s) => s.output).join(' and ')} ${missing.length === 1 ? 'was' : 'were'} not written` }, problems: [], routeProblems: empty, imported: null, previousTable: null });
  }
  const sessions = readSessionMaterial(prepared.sessionsFile);
  const routeProblems = {
    owner: checkOwnerPartFile(owner.output, sessions),
    reader: checkTableFile(reader.output, { projectDir: prepared.readerProject }),
  };
  if (routeProblems.owner.length) log(`  the owner part has ${routeProblems.owner.length} problem(s); the main agent's check covers them`);
  if (routeProblems.reader.length) log(`  route 2's table has ${routeProblems.reader.length} problem(s); the main agent's check covers them`);

  log(`Main agent running: ${main.folder}`);
  const mainRun = await runStep('main', main.folder, main.instructions, join(runsDir, 'main'), options);
  log(`  main: exit ${mainRun.exitCode ?? 'none (did not start)'}`);
  const runs = [...routes, mainRun];
  if (!existsSync(main.output)) return result({ runs, stopped: { after: 'main', why: `${main.output} was not written` }, problems: [], routeProblems, imported: null, previousTable: null });

  // The whole check, against the project itself: what the import will hold the table to.
  const problems = checkTableFile(main.output, { projectDir: prepared.projectDir, sessions });
  if (problems.length) return result({ runs, stopped: { after: 'check', why: `the merged table has ${problems.length} problem${problems.length === 1 ? '' : 's'}` }, problems, routeProblems, imported: null, previousTable: null });

  let previousTable: string | null = null;
  if (existsSync(prepared.destination)) {
    previousTable = join(prepared.workDir, 'previous-project.json');
    copyFileSync(prepared.destination, previousTable);
  }
  mkdirSync(dirname(prepared.destination), { recursive: true });
  copyFileSync(main.output, prepared.destination);
  log(`Taking the table in from ${prepared.destination}`);
  const imported = await importTable({ tableFile: prepared.destination, projectDir: prepared.projectDir, home: prepared.home, name: options.name, sessions });
  if (imported.problems.length) return result({ runs, stopped: { after: 'import', why: 'the import refused the table' }, problems: imported.problems, routeProblems, imported, previousTable });
  return result({ runs, stopped: null, problems: [], routeProblems, imported, previousTable });
}
