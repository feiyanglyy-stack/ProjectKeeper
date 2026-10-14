#!/usr/bin/env node
/**
 * pk — ProjectKeeper command line. The same command is also installed under its long name, `projectkeeper`.
 *
 *   pk serve [--port N]                 start the workbench at http://127.0.0.1:N
 *   pk add <name> <location> [...]      add a project (nothing runs until Start on its Takeover page)
 *   pk scope <projectId>                print the scope list
 *   pk projects                         list projects
 *   pk check [table] [--project <dir>] [--sessions <file>]
 *                                       check a filled ProjectKeeper table (default projectkeeper/project.json here)
 *                                       against template/projectkeeper.schema.json and the project's own files; prints
 *                                       every problem and exits 1 when there is any. Needs no workbench.
 *   pk import [table] [--home <dir>] [--name <name>] [--project <dir>] [--sessions <file>]
 *                                       check the table the same way and, when it holds, take it into the home: the
 *                                       project (the folder holding projectkeeper/, or --project) is found or added and
 *                                       read, and the Keeper's picture of it is replaced by the table's. A table with any
 *                                       problem is refused and nothing is written. Prints what it wrote.
 *   pk sessions [--project <dir>] [--home <dir>] [--name <name>] [--out <dir>]
 *                                       write the session material a table quotes the owner from: every owner message of
 *                                       the project's agent sessions (default: the current directory), each after the
 *                                       agent's answer it replies to, as session-material.md and .jsonl. They go into
 *                                       ProjectKeeper's own folder for the project (<home>/projects/<id>/table), never
 *                                       into the project; an --out inside it is refused (D107).
 *   pk check --owner-part <file> --sessions <file>
 *                                       check the owner part a takeover's first step writes ({ ownerWants, notes })
 *                                       against the schema and the session material it quotes.
 *   pk takeover [--project <dir>] [--home <dir>] [--name <name>] [--table-in home|project] --prepare
 *                                       lay out a takeover by the table in three isolated folders under
 *                                       <home>/projects/<id>/table/takeover-<time>/: owner/ (the session material),
 *                                       project-reader/ (a copy of the project), and the main agent's instructions at
 *                                       the top; prints each step's folder and instructions and the pk import command.
 *                                       Any agent can run the steps; Claude Code users run them in their own Claude Code.
 *   pk takeover ... --run codex [--model <m>] [--effort <e>]
 *                                       also run the three steps headless with Codex CLI (routes 1 and 2 at once, then
 *                                       the main agent; Codex's default model unless --model, effort high unless
 *                                       --effort), check the merged table and, when it holds, put it at its destination
 *                                       and take it in. --table-in home (default, safe for a public project) keeps the
 *                                       table at <home>/projects/<id>/table/project.json; a private project may use
 *                                       --table-in project (projectkeeper/project.json in the project). There is no
 *                                       --run claude: running a Claude subscription from another tool is against
 *                                       Anthropic's terms.
 *
 * An execution agent's own entry (Spec §7.10), all talking to the running workbench:
 *   pk context [--work <id|name>] [--purpose Start|Work] [--kind K] [--recipient R] [--since T]
 *   pk get <id>                         whatever an id in a pack names: a pack, an original (a code file: where it is
 *                                       and the version read), a note, a project rule, or the object itself in full
 *                                       with its neighbours named by id
 *   pk options                          areas, work items, lit breakpoints, open send-backs, six things and context choices
 *   pk ask "<question>"                 ask the Keeper
 *   pk help                             how to use these
 * The project is --project <id>, or the one containing --cwd <dir> (default: the current directory).
 *
 *   pk mcp [--port N] [--project <id>] [--cwd <dir>]
 *                                       the same reading commands and the table check as a local MCP server on stdin and
 *                                       stdout, for clients that take their tools over MCP (D108; src/mcp/server.ts).
 *                                       The flags are the tools' defaults; a tool call can name its own.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { App } from './server/app.ts';
import { HttpApp } from './server/http.ts';
import { registerRoutes } from './server/api.ts';
import { vendorDir } from './server/vendor.ts';
import { WorkspaceFileError } from './store/workspace.ts';
import { gitNotice, gitVersionOutput } from './util/git-check.ts';
import { checkOwnerPartFile, checkTableFile, readSessionMaterial, tableCheckReport, type TableProblem } from './table/check.ts';
import { importTable } from './table/import.ts';
import { exportProjectSessions } from './table/sessions.ts';
import { prepareTakeover, runTakeover, type PreparedTakeover, type TableIn } from './table/takeover.ts';
import { agentEntry, askEntry, Exit, type EntryOutput, type EntryTarget } from './context/agent-entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

function arg(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/** The table file a table command names (default projectkeeper/project.json here), past the flags that take a value. */
function tableArg(): string {
  const given = process.argv.slice(3).find((a, i, all) => !a.startsWith('--') && !(i > 0 && ['--project', '--sessions', '--home', '--name'].includes(all[i - 1]!)));
  return resolve(given ?? join('projectkeeper', 'project.json'));
}

function printProblems(tableFile: string, problems: readonly TableProblem[]): void {
  for (const line of tableCheckReport(tableFile, problems)) console.log(line);
}

/** `pk check`: the table, its project folder and the session material it cites; no workbench, no store. */
function checkCommand(): number {
  const projectDir = arg('--project');
  const sessionsFile = arg('--sessions');
  // The owner part a takeover's first step writes, held to the session material it is read from (D107).
  const ownerPart = arg('--owner-part');
  if (ownerPart) {
    if (!sessionsFile) { console.error('usage: pk check --owner-part <file> --sessions <session-material.jsonl>'); return 2; }
    const file = resolve(ownerPart);
    const problems = checkOwnerPartFile(file, readSessionMaterial(resolve(sessionsFile)));
    if (!problems.length) { console.log(`${file}: no problems.`); return 0; }
    console.log(`${file}: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
    for (const p of problems) console.log(`  ${p.at}  ${p.problem}`);
    return 1;
  }
  const tableFile = tableArg();
  const problems = checkTableFile(tableFile, {
    projectDir: projectDir ? resolve(projectDir) : undefined,
    sessions: sessionsFile ? readSessionMaterial(resolve(sessionsFile)) : null,
  });
  printProblems(tableFile, problems);
  return problems.length ? 1 : 0;
}

/** `pk import`: the same check, then the table taken into the home (src/table/import.ts). */
async function importCommand(): Promise<number> {
  const tableFile = tableArg();
  const projectDir = arg('--project');
  const sessionsFile = arg('--sessions');
  const r = await importTable({
    tableFile, projectDir: projectDir ? resolve(projectDir) : undefined, home: arg('--home') ?? undefined, name: arg('--name') ?? undefined,
    sessions: sessionsFile ? readSessionMaterial(resolve(sessionsFile)) : null,
  });
  if (r.problems.length) { printProblems(tableFile, r.problems); return 1; }
  const c = r.counts!;
  const list = (counts: Readonly<Record<string, number>>) => Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing';
  console.log(`${tableFile}: taken into ${r.added ? 'the new project' : 'project'} ${r.projectName} (${r.projectId}) in ${r.home}.`);
  console.log(`  Replaced the earlier picture: ${list(c.removed)}`);
  console.log(`  Sources cited: ${c.sources.cited} (${c.sources.reused} as intake read them, ${c.sources.written} written from the table)`);
  console.log(`  Reference items: ${list(c.reference)}`);
  console.log(`  Work items: ${c.threads} (with ${c.facts} fact records), relations written: ${c.relations}, earlier generations: ${c.generations}, process links: ${c.links}`);
  console.log(`  Code territories: ${c.territories}, notes: ${c.notes}`);
  console.log(`  Graph: ${c.graph.nodes} nodes, ${c.graph.relations} relations`);
  for (const w of r.warnings ?? []) console.warn(`  ${w}`);
  return 0;
}

/** `pk sessions`: the session material of a project, written outside it (src/table/sessions.ts, D107). */
async function sessionsCommand(): Promise<number> {
  const out = arg('--out');
  let r: Awaited<ReturnType<typeof exportProjectSessions>>;
  try {
    r = await exportProjectSessions({ projectDir: resolve(arg('--project') ?? process.cwd()), home: arg('--home') ?? undefined, name: arg('--name') ?? undefined, out: out ?? undefined });
  } catch (e) { console.error((e as Error).message); return 2; }
  console.log(`Session material of ${r.added ? 'the new project' : 'project'} ${r.projectName} (${r.projectId}) in ${r.home}:`);
  console.log(`  ${r.ownerMessages} owner message${r.ownerMessages === 1 ? '' : 's'} from ${r.sessions} session${r.sessions === 1 ? '' : 's'}, ${r.records} records with the agent answers before them`);
  console.log(`  ${r.markdown}`);
  console.log(`  ${r.jsonl}   (pk check / pk import --sessions)`);
  for (const w of r.warnings) console.warn(`  ${w}`);
  return 0;
}

const TAKEOVER_USAGE = 'usage: pk takeover [--project <dir>] [--home <dir>] [--name <name>] [--table-in home|project] (--prepare | --run codex [--model <m>] [--effort <e>])';

function printSteps(t: PreparedTakeover): void {
  console.log(`Takeover of ${t.added ? 'the new project' : 'project'} ${t.projectName} (${t.projectId}), laid out in ${t.workDir}`);
  console.log(`  Session material: ${t.ownerMessages} owner message${t.ownerMessages === 1 ? '' : 's'} from ${t.sessions} session${t.sessions === 1 ? '' : 's'}`);
  console.log(`  Project copy: ${t.repos.map((r) => `${r.path} at ${r.commit}`).join(', ')}${t.skipped.length ? `; ${t.skipped.length} entr${t.skipped.length === 1 ? 'y' : 'ies'} left out (ignored by git, node_modules, links)` : ''}`);
  for (const w of t.warnings) console.warn(`  ${w}`);
  const { owner, reader, main } = t.steps;
  console.log('\nStep 1 — the owner\'s words (run at the same time as step 2; each agent sees only its own folder):');
  console.log(`  folder:       ${owner.folder}\n  instructions: ${owner.instructions}\n  writes:       ${owner.output}`);
  console.log('Step 2 — the project:');
  console.log(`  folder:       ${reader.folder}\n  instructions: ${reader.instructions}\n  writes:       ${reader.output}`);
  console.log('Step 3 — the main agent, after both:');
  console.log(`  folder:       ${main.folder}\n  instructions: ${main.instructions}\n  writes:       ${main.output}`);
  console.log(`Then put ${main.output} at ${t.destination} and take it in:\n  ${t.importCommand}`);
}

/**
 * `pk takeover`: the three-step takeover by the table (src/table/takeover.ts, D107). `--prepare` lays out the folders
 * for any agent; `--run codex` also runs the steps headless with Codex CLI and takes the table in. PK_TAKEOVER_AGENT
 * names a program to run instead of `codex` (a .mjs, .js or .ts file runs under this node), for tests and stand-ins.
 */
async function takeoverCommand(): Promise<number> {
  const run = arg('--run');
  const prepare = process.argv.includes('--prepare');
  const tableIn = arg('--table-in', 'home');
  if (run === 'claude') {
    console.error('pk takeover does not run Claude Code: running a Claude subscription from another tool is against Anthropic\'s terms. Run pk takeover --prepare and give the three steps to your own Claude Code, each in its folder.');
    return 2;
  }
  if ((run !== null && run !== 'codex') || (run === null && !prepare) || (tableIn !== 'home' && tableIn !== 'project')) { console.error(TAKEOVER_USAGE); return 2; }
  const options = { projectDir: resolve(arg('--project') ?? process.cwd()), home: arg('--home') ?? undefined, name: arg('--name') ?? undefined, tableIn: tableIn as TableIn };
  if (!run) {
    let t: PreparedTakeover;
    try { t = await prepareTakeover(options); } catch (e) { console.error((e as Error).message); return 2; }
    printSteps(t);
    return 0;
  }
  const standIn = process.env.PK_TAKEOVER_AGENT?.trim();
  const agentCommand = standIn ? (/\.(m?js|ts)$/i.test(standIn) ? [process.execPath, resolve(standIn)] : [standIn]) : undefined;
  let r: Awaited<ReturnType<typeof runTakeover>>;
  try {
    r = await runTakeover({ ...options, model: arg('--model') ?? undefined, effort: arg('--effort') ?? undefined, agentCommand, log: (line) => console.log(line) });
  } catch (e) { console.error((e as Error).message); return 2; }
  const t = r.prepared;
  console.log(`\nWork folder: ${t.workDir} (each step's events, stderr, times and last message under runs/)`);
  for (const s of r.runs) if (s.lastMessage) console.log(`\n${s.step}, last message:\n${s.lastMessage.trim()}`);
  if (r.stopped) {
    console.log(`\nStopped after ${r.stopped.after}: ${r.stopped.why}. Nothing was taken in.`);
    if (r.problems.length) printProblems(t.steps.main.output, r.problems);
    console.log(`Once ${t.steps.main.output} checks clean, put it at ${t.destination} and take it in:\n  ${t.importCommand}`);
    return 1;
  }
  console.log(`\nTaken in from ${t.destination}${r.previousTable ? ` (the table that stood there is kept as ${r.previousTable})` : ''}: ${r.imported!.counts!.graph.nodes} nodes in the graph.`);
  for (const w of r.imported!.warnings ?? []) console.warn(`  ${w}`);
  return 0;
}

/**
 * `pk mcp` (D108): an MCP server on stdin and stdout until the client closes stdin. Stdout carries the protocol and
 * nothing else, so anything that would be printed there while it runs goes to stderr instead.
 */
async function mcpCommand(): Promise<number> {
  const toStderr = (...parts: unknown[]) => console.error(...parts);
  console.log = toStderr; console.info = toStderr; console.debug = toStderr;
  const { serveMcp } = await import('./mcp/server.ts');
  await serveMcp(process.stdin, process.stdout, { port: arg('--port'), project: arg('--project'), cwd: resolve(arg('--cwd') ?? process.cwd()), home: arg('--home') ?? undefined });
  return 0;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'serve';
  if (command === 'mcp') return mcpCommand();
  if (command === 'check') return checkCommand();
  if (command === 'takeover') return takeoverCommand();
  // The import opens its home itself, and only for a table that holds.
  if (command === 'import') return importCommand();
  if (command === 'sessions') return sessionsCommand();
  const app = new App(arg('--home') ?? undefined);
  const VALUE_FLAGS = ['--home', '--port', '--project', '--cwd', '--thread', '--fetch', '--work', '--purpose', '--kind', '--recipient', '--since'];
  const positionals = () => process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(all[i - 1]!)));
  if (command === 'serve') {
    const http = new HttpApp();
    registerRoutes(http, app, join(appRoot, 'ui'), vendorDir(appRoot));
    http.route('GET', '/api/events', ({ res }) => { http.sse.attach(res); });
    app.on('event', (event) => http.sse.broadcast('app', event));
    const port = Number(arg('--port', String(app.workspace.settings.port)));
    app.servedPort = port;
    await app.initKeeper({ fakeProvider: process.argv.includes('--fake-provider') });
    if (app.workspace.settings.watchProjects === false) console.log('Not watching the projects (settings.watchProjects is false): this home works through what it already holds.');
    // A project the owner has not started is not watched: before `Start` nothing counts as waiting (D105).
    else for (const p of app.workspace.list()) { try { if (p.lastScopedAt) app.startWatching(p.id); } catch (e) { console.warn(`[watch] ${p.id}: ${(e as Error).message}`); } }
    const server = await http.listen(port);
    console.log(`ProjectKeeper workbench: http://127.0.0.1:${server.port}/`);
    // Without git a repository is read as a folder of files and nothing says why (a new Mac has no git until the
    // command line tools are installed): said here, once.
    const aboutGit = gitNotice(gitVersionOutput());
    if (aboutGit) console.warn(`\n${aboutGit}\n`);
    const stop = async () => { app.stopAll(); await app.flushAll(); await server.close(); process.exit(0); };
    process.on('SIGINT', () => { void stop(); });
    process.on('SIGTERM', () => { void stop(); });
    // Closing the terminal window sends this one: stopped the same way, so what was being written is written.
    process.on('SIGHUP', () => { void stop(); });
    return new Promise(() => { /* keep running */ });
  }
  if (command === 'add') {
    const [name, ...locations] = positionals();
    if (!name || locations.length === 0) { console.error('usage: pk add <name> <location> [...]'); return 2; }
    const project = app.addProject(name, locations);
    await app.flushAll();
    console.log(JSON.stringify({ id: project.id, name: project.name, state: 'Not organized yet', next: 'Open the workbench: Keeper → Takeover → choose a depth → Start' }, null, 2));
    return 0;
  }
  if (command === 'intake') {
    const id = positionals()[0];
    if (!id) { console.error('usage: pk intake <projectId>'); return 2; }
    const result = await app.intakeProject(id);
    await app.flushAll();
    console.log(JSON.stringify(result, null, 2));
    app.stopAll();
    return 0;
  }
  if (command === 'scope') {
    const id = positionals()[0];
    if (!id) { console.error('usage: pk scope <projectId>'); return 2; }
    const project = app.project(id);
    for (const item of project.scope) {
      console.log(`${item.category.padEnd(14)} ${item.relation.padEnd(24)} ${item.path}\n${' '.repeat(39)}${item.reason}`);
    }
    if (project.scopeQuestions.length) console.log('\nQuestions:\n' + project.scopeQuestions.map((q) => `- ${q.question}${q.answer ? ` → ${q.answer.text}` : ''}`).join('\n'));
    return 0;
  }
  if (command === 'ask') {
    // Query entry without any host integration (§7.6): talks to the running workbench (src/context/agent-entry.ts).
    const portFlag = arg('--port') ? ` --port ${arg('--port')}` : '';
    const positional = process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--') && ['--project', '--cwd', '--thread', '--port', '--home', '--fetch'].includes(all[i - 1]!)));
    return askEntry(entryTarget(app), console_, {
      question: positional.join(' '), fetch: arg('--fetch'), thread: arg('--thread'), wait: process.argv.includes('--wait'),
      fetchLater: (projectId, jobId) => `pk ask --project ${projectId}${portFlag} --fetch ${jobId}`,
      askAgain: (projectId, thread) => `pk ask --project ${projectId}${portFlag} --thread ${thread} "<question>"`,
    });
  }
  if (['context', 'get', 'options', 'help'].includes(command)) {
    return agentEntry(command, entryTarget(app), console_, positionals(), { work: arg('--work'), purpose: arg('--purpose'), kind: arg('--kind'), recipient: arg('--recipient'), since: arg('--since') });
  }
  if (command === 'projects') {
    for (const p of app.workspace.list()) console.log(`${p.id}\t${p.name}\t${p.locations.join(', ')}`);
    return 0;
  }
  console.error(`unknown command: ${command}`);
  return 2;
}

/** The workbench and project the agent entry reads: `--port` (default from the settings), `--project` or `--cwd`. */
function entryTarget(app: App): EntryTarget {
  return { base: `http://127.0.0.1:${arg('--port', String(app.workspace.settings.port))}`, project: arg('--project'), cwd: arg('--cwd') ?? process.cwd() };
}

/** The agent entry's text on the terminal: what was asked for on stdout, the rest on stderr. */
const console_: EntryOutput = { out: (text) => console.log(text), err: (text) => console.error(text) };

main().then((code) => { process.exitCode = code; }, (error) => {
  if (error instanceof Exit) { process.exitCode = error.code; return; }
  // A settings file that cannot be read is the owner's to correct: the message names it and says how; no stack.
  console.error(error instanceof WorkspaceFileError ? error.message : error);
  process.exitCode = 1;
});
