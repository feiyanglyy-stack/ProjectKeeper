// §6.7 the Project scope additions: ledger coverage (§1.16, CKC-22 AC-15/16), the layer mapping,
// earlier generations, the deepening questions, and the `Project folder` standing authorization
// (§1.14, CKC-26 AC-7/8). Pure rendering: the ScopeKView comes in as a parameter.
import { h, fmtRel } from '../app.js';

const ensureStyle = () => {
  if (document.getElementById('k-views-css')) return;
  const link = document.createElement('link');
  link.id = 'k-views-css';
  link.rel = 'stylesheet';
  link.href = '/k/k-views.css';
  document.head.append(link);
};

const num = (n) => Number(n).toLocaleString('en-US');
const day = (at) => (at ? at.slice(0, 10) : '—');
const sec = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

const section = (title, ...kids) => h('section', { class: 'kv-section kv-card', dataset: { section: title } },
  h('h3', {}, title), ...kids);
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const mb = (bytes) => (bytes ? `${Math.round(bytes / 100_000) / 10} MB` : null);
const pathList = (paths, more, kind) => h('ul', { class: 'kv-notread-paths', dataset: { list: kind } },
  paths.map((p) => h('li', { class: 'kv-mono' }, p)),
  more ? h('li', { class: 'kv-faint' }, `and ${num(more)} more`) : null);

// How deep the ledger reads one language of the code, in the words the Code view says it (code-view.js levelText; the
// same CodeLanguageView, ScopeKView ledger.languages[].code; §1.16, §6.7, §6.17; D98 补): read by the TypeScript compiler,
// to symbols; read by the code engine, to symbols, with the imports it resolved to a file of the repository and those it
// left unresolved naming one; not read, its files and sizes only. Where a file is not read or a reference was left
// unresolved, residual calls there are Inferred; the ledger's own words for that are on hover.
function readText(l) {
  if (!l.readBy) return { text: 'not read: files and sizes only', inferred: true };
  const measured = [
    l.read < l.files ? `${num(l.read)} of ${num(l.files)} files read` : null,
    l.imports ? `${plural(l.imports.resolved, 'import')} resolved` : null,
    l.imports ? `${num(l.imports.unresolvedNamingRepoFiles)} left unresolved naming a repository file` : null,
    l.namedButUnreferenced ? `${plural(l.namedButUnreferenced, 'file')} named by other files but reached by no counted reference` : null,
    l.parseErrors ? `${plural(l.parseErrors, 'file')} not parsed in full` : null,
  ].filter(Boolean);
  return { text: `read by the ${l.readBy === 'compiler' ? 'TypeScript compiler' : 'code engine'}: symbols${measured.length ? `, ${measured.join(', ')}` : ''}`, inferred: !l.complete };
}

/** One language's row: the code as the Code view says it, prose and data as no code (their files and sizes). */
function languageCell(l) {
  if (!l.code) return h('td', { class: 'kv-reads', dataset: { readBy: 'not-code' } }, 'not code: files and sizes only');
  const r = readText(l.code);
  return h('td', { class: 'kv-reads', dataset: { readBy: l.code.readBy ?? 'none' }, title: l.code.gaps.length ? l.code.gaps.join('\n') : null },
    r.text, r.inferred ? [' ', h('span', { class: 'kv-faint' }, '(residual calls here are Inferred)')] : null);
}

/**
 * What the ledger keeps without reading it (ScopeKView ledger.notRead; QC AY): the document versions it holds without
 * their text — over the size it reads to, or not text — with the reports among them, whose verdicts are not read; the
 * files outside version control too large to read; and what that means, in the ledger's own words. Nothing when it read
 * everything.
 */
function notReadRows(nr) {
  if (!nr) return [];
  const docLimit = mb(nr.documentLimitBytes), looseLimit = mb(nr.looseLimitBytes);
  return [
    h('dt', {}, 'Kept without reading'),
    h('dd', { class: 'kv-notread' },
      nr.versionsWithoutText ? h('div', { dataset: { part: 'versions' } },
        h('div', {}, `${plural(nr.versionsWithoutText, 'document version')} kept without ${nr.versionsWithoutText === 1 ? 'its' : 'their'} text — ${docLimit ? `over ${docLimit}` : 'over the size the ledger reads'}, or not text:`),
        pathList(nr.paths, nr.morePaths, 'versions'),
        nr.reports?.length ? h('div', { dataset: { part: 'reports' } }, `${nr.reports.length === 1 ? 'A report' : `${num(nr.reports.length)} reports`} among them, whose verdicts are not read: `, nr.reports.map((p, i) => [i ? ', ' : '', h('span', { class: 'kv-mono' }, p)])) : null) : null,
      nr.unversionedTooLarge ? h('div', { dataset: { part: 'loose' } },
        h('div', {}, `${plural(nr.unversionedTooLarge, 'file')} outside version control ${looseLimit ? `over ${looseLimit}` : 'too large to read'}, not read:`),
        pathList(nr.unversionedPaths, Math.max(0, nr.unversionedTooLarge - nr.unversionedPaths.length), 'loose')) : null,
      nr.effect ? h('div', { class: 'kv-faint', dataset: { part: 'effect' } }, nr.effect) : null),
  ];
}

function ledgerSection(ledger) {
  if (!ledger) return section('Ledger coverage', h('div', { class: 'kv-note-block' }, 'The ledger has not been built yet.'));
  return section('Ledger coverage',
    h('table', { class: 'kv-mini' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Repo'), h('th', {}, 'Commits'), h('th', {}, 'Branches'), h('th', {}, 'Merges'), h('th', {}, 'Span'), h('th', {}, 'Version history'))),
      h('tbody', {}, ledger.repos.map((r) => h('tr', {},
        h('td', { class: 'kv-mono' }, r.repo),
        // On the trunk alone and over all refs, when the two differ (ScopeKView ledger.repos[].trunkCommits).
        h('td', {}, r.trunkCommits != null && r.trunkCommits !== r.commits
          ? h('span', { title: 'commits on the trunk · commits on all refs' }, `${num(r.trunkCommits)} trunk · ${num(r.commits)} all`) : num(r.commits)),
        h('td', {}, num(r.branches)),
        h('td', {}, num(r.merges)),
        h('td', {}, `${day(r.from)} → ${day(r.to)}`),
        // Every repo here is under version control: `historyFrom` is set when documents entered it later than the first
        // commit (an import root, CKC-22 AC-15); otherwise the history starts at the first commit.
        h('td', {}, r.historyFrom || r.from ? h('span', {}, `since ${day(r.historyFrom ?? r.from)}`) : '—'))))),
    h('table', { class: 'kv-mini', style: 'margin-top:8px' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Language'), h('th', {}, 'Code structure reaches'), h('th', {}, 'Files'))),
      h('tbody', {}, ledger.languages.map((l) => h('tr', { dataset: { lang: l.language } },
        h('td', {}, l.language),
        // What the Code view says of the language (CKC-03 AC-27): a language the ledger reads no references of is not
        // called read, and the engine's languages are read to symbols with what it left unresolved said.
        languageCell(l),
        h('td', {}, num(l.files)))))),
    h('dl', { class: 'kv-kv', style: 'margin-top:8px' },
      h('dt', {}, 'Sessions read'), h('dd', {}, `${num(ledger.sessions.read)} · hosts: ${ledger.sessions.hosts.join(', ') || '—'}`),
      ledger.sessions.missing.length ? h('dt', {}, 'Unreadable sessions') : null,
      ledger.sessions.missing.length ? h('dd', {}, ledger.sessions.missing.map((m) => h('div', { class: 'kv-missing' }, `⚠ ${m.host} · ${day(m.from)} → ${day(m.to)} — ${m.why}`))) : null,
      h('dt', {}, 'Docs outside version control'), h('dd', {}, num(ledger.unversionedDocs)),
      notReadRows(ledger.notRead),
      h('dt', {}, 'Last rebuild'), h('dd', {}, ledger.lastRebuild ? `${fmtRel(ledger.lastRebuild.at)} · took ${sec(ledger.lastRebuild.ms)}` : '—')));
}

const layersSection = (layers) => section('Layers',
  h('table', { class: 'kv-mini' },
    h('thead', {}, h('tr', {}, h('th', {}, 'File / directory'), h('th', {}, 'Layer'), h('th', {}, 'Note'), h('th', {}, 'Current'))),
    h('tbody', {}, layers.map((l) => h('tr', {},
      h('td', { class: `kv-mono${l.current ? '' : ' kv-history'}` }, l.path),
      h('td', {}, l.layer),
      h('td', { class: 'kv-muted' }, l.note ?? '—'),
      h('td', {}, l.current ? h('span', { class: 'kv-tag kv-green' }, 'current') : h('span', { class: 'kv-tag' }, 'history')))))));

const generationsSection = (gens) => section('Earlier generations',
  gens.length
    ? h('table', { class: 'kv-mini' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Generation'), h('th', {}, 'Ended'), h('th', {}, 'Ended by'))),
        h('tbody', {}, gens.map((g) => h('tr', {},
          h('td', {}, g.name),
          h('td', {}, day(g.ended.at)),
          h('td', { class: 'kv-muted' }, g.endedBy.label)))))
    : h('div', { class: 'kv-note-block' }, 'The material names no earlier generations.'));

const questionsSection = (questions, ctx) => section('Questions the deepening asks',
  questions
    ? h('div', {},
        h('ul', { style: 'margin:0 0 6px; padding-left:18px' }, questions.paths.map((p) => h('li', {}, p))),
        h('button', { class: 'btn small kv-btn', type: 'button', onClick: () => ctx.navigate('keeper', { roundId: questions.roundId, docId: questions.docId }) }, 'Open the question list in the round'))
    : h('div', { class: 'kv-note-block' }, 'No question list yet — it is written by the first orientation.'));

const folderSection = (pf) => {
  if (!pf || !pf.granted) {
    return section('Project folder',
      h('div', { class: 'kv-note-block', dataset: { granted: 'no' } },
        h('p', {}, h('b', {}, 'Not granted.'), ' Keeper writes nothing into the project: semantic patches, Keeper-given numbers and distilled decisions live only on this workbench.'),
        h('p', {}, 'This authorization can be granted on the Keeper page, under Project folder. With it, Keeper writes exactly those files into one folder you choose (for example ', h('span', { class: 'kv-mono' }, '<project>/projectkeeper/'), '); by default Keeper commits them itself — every commit contains only that folder, says it comes from ProjectKeeper, and is never pushed. You can also choose write-only: the files then appear as uncommitted changes.')));
  }
  return section('Project folder',
    h('dl', { class: 'kv-kv', dataset: { granted: 'yes' } },
      h('dt', {}, 'Authorization'), h('dd', {}, h('span', { class: 'kv-tag kv-green' }, 'granted'), pf.authorizationId ? ` · ${pf.authorizationId}` : ''),
      h('dt', {}, 'Folder'), h('dd', { class: 'kv-mono' }, pf.path ?? '—'),
      h('dt', {}, 'Committed by Keeper'), h('dd', {}, pf.commits ? 'yes — each commit contains only this folder, never pushed' : 'no — writes appear as uncommitted changes'),
      h('dt', {}, 'Last write'), h('dd', {}, pf.lastWrite ? `${fmtRel(pf.lastWrite.at)}${pf.lastWrite.commit ? ` · ${pf.lastWrite.commit.slice(0, 7)}` : ''}` : 'never')));
};

export function renderScopeK(container, scopeK, ctx) {
  ensureStyle();
  container.replaceChildren();
  container.append(h('div', { class: 'kv-scope', dataset: { kv: 'scope-k' } },
    ledgerSection(scopeK.ledger),
    layersSection(scopeK.layers),
    generationsSection(scopeK.generations),
    questionsSection(scopeK.questions, ctx),
    folderSection(scopeK.projectFolder)));
  return container;
}
