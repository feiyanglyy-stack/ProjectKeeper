// Browser check for the UI line's batch S6: what the workbench shows of the new backend data — the scope list's
// third-party/generated/ignored sections with their fields, the toolchain, the coverage's organizing levels (Settled by
// rule among them), the owner's-words step, and the boundary denials. The levels and the owner's-words step are the
// product's own figures, computed from the takeover rounds the fixture plants; the check holds the page to them and
// them to the rounds' own steps (QC AY). QC AY package C adds what the rounds' new data looks like on the page: what the
// ledger keeps without reading it (Project scope), how each path of the depth question was counted (Keeper), and the
// Follow up news — the round with news in `Notes (attention)` by kind,
// each entry with its position and its jump, and the last round's "found nothing new" in the top bar. BC adds what each
// deepening path read against its plan, the deepening as it ran beside the estimate, and the part reads beside the
// levels (CKC-13 AC-8), all counted from the recorded reads. D99 (W8) replaces BH's reading assignments: the deepening
// is run by its main agent, and the page shows it by lane — what each answers, its slots, what it read — with the
// coverage check's state, and in the round tree the main agent's stages, each lane with its brief and report, and what
// no lane read with each account beside it. BK (QC AH #6, #11) adds what
// an object still lacks — in its popover and in its full details' Propagation part, each item with the change it comes
// from and the round that judged it — `Since last visit` summing up each Follow up round since the last visit, the
// header's count of the Follow up results listed, and a seen round's result reachable again from `Since last visit`,
// from the object it judged and from its round in the Keeper view. It drives
// headless Chrome against a workbench that is ALREADY RUNNING on a seeded fixture home (never a real project), whose
// planner has nothing to start (the takeover is done; the last Follow up round ended within the hour):
//
//   node scripts/seed-ui-fixture.ts <fixture home>
//   node src/cli.ts serve --home <fixture home> --port 4925
//   node scripts/ui-s6-check.mjs http://127.0.0.1:4925 <dir for screenshots>
//
// Every assertion is read off the page (element text, select options, scroll widths), not judged by eye. It writes a
// probe document into the fixture project and presses Rescan to see it arrive, and it opens the Follow up result, which
// then leaves `Notes (attention)`: seed the home again before running it a second time. Prints one line per check and exits 1
// if any failed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './ui-cdp.mjs';

const [base = 'http://127.0.0.1:4925', outDir = 'ui-s6-shots'] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const workspace = await (await fetch(`${base}/api/workspace`)).json();
const projectId = workspace.projects[0]?.id;
const projectDir = workspace.projects[0]?.locations?.[0];
if (!projectId || !projectDir) throw new Error('the fixture home has no project or no location');
const PID = encodeURIComponent(projectId);
const get = async (path) => (await fetch(`${base}/api/projects/${PID}${path}`)).json();
const url = (view, rest = '') => `${base}/#/p/${PID}/${view}${rest ? `/${rest}` : ''}`;
const scopeData = await get('/scope');
if (!scopeData.scopeView) throw new Error('the fixture API has no sectioned scope view');
// The project summary as the served workbench computed it (the top bar and the Keeper view read it).
const summary = await get('');
const scopeSections = [
  ['in-scope', 'In scope', scopeData.scopeView.inScope],
  ['third-party', 'Third-party material', scopeData.scopeView.thirdParty],
  ['generated', 'Generated', scopeData.scopeView.generated],
  ['ignored-documents', 'Ignored, holding documents', scopeData.scopeView.ignoredDocuments],
  ['excluded', 'Excluded', scopeData.scopeView.excluded],
].map(([id, title, entries]) => ({ id, title, entries }));
const expectedScopeRows = (entries) => entries.map((view) => {
  const item = view.item ?? view;
  return {
    path: item.path,
    category: item.category,
    relation: item.relation,
    reason: view.reason ?? item.reason,
    relationDetails: [item.copyOf ? `copy of ${item.copyOf}` : null, item.worktreeOf ? `of ${item.worktreeOf}` : null, item.versionControl === 'none' ? 'no version control' : null].filter(Boolean),
    detailText: [item.missing?.reason, view.worktree?.sentence, view.ignored?.rule, view.ignored?.sentence, view.classification?.sentence].filter(Boolean),
    tags: [item.readOnly ? 'read-only' : null, item.missing ? item.missing.reason : null, view.worktree ? (view.worktree.merged ? 'merged' : 'not merged') : null, view.classification?.basis === 'Inferred' ? 'Inferred' : null].filter(Boolean),
    covers: (view.covers ?? []).map((cover) => cover.summary),
    hasReasonSource: (item.reasonSourceIds ?? []).length > 0,
  };
});

const b = await launch({ width: 1280, height: 800 });
await b.navigate(url('scope'));
const page = (body) => b.evaluate(`(async () => { const $ = (s) => document.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];\n ${body} })()`);
const settle = async (ms = 350) => { await sleep(ms); await b.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
await b.waitFor(`document.querySelector('#main h1')?.textContent === 'Project scope'`, { label: 'Project scope' });
const goView = async (view, title) => { await b.evaluate(`location.hash = ${JSON.stringify(url(view).split('#')[1])}`); await b.waitFor(`document.querySelector('#main h1')?.textContent === ${JSON.stringify(title)}`, { label: title }); await settle(900); };
const noScroll = async (name) => {
  const m = await page(`return { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, undef: (document.body.textContent.match(/undefined|\\[object Object\\]/g) ?? []).length };`);
  check(`${name}: no horizontal scroll at 1280×800, no “undefined” or “[object Object]” on the page`, m.scrollW <= m.innerW && m.undef === 0, `scrollWidth ${m.scrollW} ≤ ${m.innerW} · stray text ${m.undef}`);
};

try {
  // ── Project scope: the sectioned list with every new field (CKC-04 AC-13, AC-15, AC-17; Spec §6.7) ──────────
  await goView('scope', 'Project scope');
  const sectionIds = scopeSections.map((section) => section.id);
  const shownScope = await page(`
    const ids = ${JSON.stringify(scopeSections.map((section) => section.id))};
    return Object.fromEntries(ids.map((id) => {
      const section = $('#' + id);
      if (!section) return [id, null];
      const rows = $$(':scope > div > .scope-item', section).map((row) => {
        const columns = [...row.children];
        const reason = columns[2]?.querySelector('.reason');
        return {
          path: columns[2]?.querySelector('.path')?.textContent ?? '',
          category: columns[0]?.querySelector('.tag')?.textContent ?? '',
          relation: columns[1]?.childNodes[0]?.textContent?.trim() ?? '',
          reason: reason?.childNodes[0]?.textContent ?? '',
          relationText: columns[1]?.textContent ?? '',
          detailText: columns[2]?.textContent ?? '',
          tags: $$('.tag', row).map((tag) => tag.textContent),
          covers: $$('button.text-btn', columns[2]).filter((button) => button.parentElement?.textContent.startsWith('Covered by')).map((button) => button.textContent),
          hasReasonSource: Boolean(reason?.querySelector('button.text-btn')),
        };
      });
      return [id, { title: section.querySelector(':scope > header')?.childNodes[0]?.textContent?.trim() ?? '', rows }];
    }));`);
  const scopeProblems = [];
  for (const section of scopeSections) {
    const shown = shownScope[section.id];
    const expected = expectedScopeRows(section.entries);
    const expectedTitle = `${section.title} (${expected.length})`;
    if (!shown) { scopeProblems.push(`${section.id}: section missing`); continue; }
    if (shown.title !== expectedTitle) scopeProblems.push(`${section.id}: title ${JSON.stringify(shown.title)} != ${JSON.stringify(expectedTitle)}`);
    if (shown.rows.length !== expected.length) scopeProblems.push(`${section.id}: ${shown.rows.length} rows != ${expected.length}`);
    const shownPaths = shown.rows.map((row) => row.path).sort();
    const expectedPaths = expected.map((row) => row.path).sort();
    if (JSON.stringify(shownPaths) !== JSON.stringify(expectedPaths)) scopeProblems.push(`${section.id}: paths ${JSON.stringify(shownPaths)} != ${JSON.stringify(expectedPaths)}`);
    for (const fact of expected) {
      const row = shown.rows.find((candidate) => candidate.path === fact.path);
      if (!row) continue;
      if (row.category !== fact.category) scopeProblems.push(`${fact.path}: category ${JSON.stringify(row.category)} != ${JSON.stringify(fact.category)}`);
      if (row.relation !== fact.relation) scopeProblems.push(`${fact.path}: relation ${JSON.stringify(row.relation)} != ${JSON.stringify(fact.relation)}`);
      if (row.reason !== fact.reason) scopeProblems.push(`${fact.path}: reason differs`);
      if (row.hasReasonSource !== fact.hasReasonSource) scopeProblems.push(`${fact.path}: reason-source control differs`);
      for (const text of fact.relationDetails) if (!row.relationText.includes(text)) scopeProblems.push(`${fact.path}: missing relation detail ${JSON.stringify(text)}`);
      for (const text of fact.detailText) if (!row.detailText.includes(text)) scopeProblems.push(`${fact.path}: missing detail ${JSON.stringify(text)}`);
      for (const tag of fact.tags) if (!row.tags.includes(tag)) scopeProblems.push(`${fact.path}: missing tag ${JSON.stringify(tag)}`);
      if (JSON.stringify(row.covers.sort()) !== JSON.stringify(fact.covers.sort())) scopeProblems.push(`${fact.path}: Covered by ${JSON.stringify(row.covers)} != ${JSON.stringify(fact.covers)}`);
    }
  }
  check('the scope list matches the fixture API section by section: title counts, entries and complete row details', scopeProblems.length === 0, scopeProblems.join(' | ') || scopeSections.map((section) => `${section.title} ${section.entries.length}`).join(' | '));

  const outerVendor = join(projectDir, 'vendor');
  const chartVendor = join(projectDir, 'vendor', 'chart-lib');
  const vendorFacts = scopeData.scopeView.thirdParty.filter((view) => [outerVendor, chartVendor].includes((view.item ?? view).path));
  const vendorRows = shownScope['third-party']?.rows.filter((row) => [outerVendor, chartVendor].includes(row.path)) ?? [];
  const outerFact = vendorFacts.find((view) => (view.item ?? view).path === outerVendor);
  const chartFact = vendorFacts.find((view) => (view.item ?? view).path === chartVendor);
  const outerRow = vendorRows.find((row) => row.path === outerVendor);
  const chartRow = vendorRows.find((row) => row.path === chartVendor);
  check('vendor and vendor/chart-lib both stay in Third-party with their own classification and rule details',
    vendorFacts.length === 2 && vendorRows.length === 2
      && outerFact?.classification?.sentence && outerRow?.detailText.includes(outerFact.classification.sentence)
      && chartFact?.classification?.sentence && chartRow?.detailText.includes(chartFact.classification.sentence)
      && (chartFact?.covers ?? []).every((cover) => chartRow?.covers.includes(cover.summary)),
    JSON.stringify({ api: vendorFacts.map((view) => (view.item ?? view).path), ui: vendorRows.map((row) => row.path), chartCovers: chartRow?.covers ?? [] }));

  const rowText = (sel) => page(`const el = $('#${sel} .scope-item'); return el ? el.textContent : null;`);
  const thirdParty = await rowText('third-party');
  check('third-party material says who classified it, marked as an inference', /Classified by the Keeper \(Inferred\): vendored code/.test(thirdParty), thirdParty?.slice(0, 200));
  const thirdPartyTag = await page(`return $$('#third-party .scope-item .tag').map((t) => t.textContent);`);
  check('the Keeper’s classification carries the Inferred tag', thirdPartyTag.includes('Inferred'), thirdPartyTag.join(' '));
  const generated = await rowText('generated');
  check('generated output says the owner classified it', /Classified by the owner \(Explicit\): build output/.test(generated), generated?.slice(0, 160));

  const ignored = await rowText('ignored-documents');
  check('an ignored directory names its rule and says the owner decides about its documents', /\.gitignore line 3: \/drafts\//.test(ignored) && /2 files left out, 2 of them documents \(drafts\/ideas\.md, drafts\/roadmap-sketch\.md\) — the owner decides whether to include them/.test(ignored), ignored?.slice(0, 260));
  const excluded = await page(`return $$('#excluded .scope-item').map((x) => x.textContent);`);
  check('a merely ignored directory stays with the excluded, with its rule and count', excluded.some((x) => /\.gitignore line 2: \/scratch\//.test(x) && /2 files left out/.test(x) && !/owner decides/.test(x)), excluded.map((x) => x.slice(0, 90)).join(' | '));
  const question = await page(`return $$('#main .section').find((s) => s.querySelector('header')?.textContent === 'Questions for you')?.textContent ?? '';`);
  check('the ignored documents are put to the owner as a scope question', /drafts is left out by the project's ignore rules/.test(question) && /Should they be organized as project material\?/.test(question), question.slice(0, 200));

  const wt = await page(`return $$('#in-scope .scope-item').filter((x) => x.textContent.includes('worktree of') || /Merged into|Not merged into/.test(x.textContent)).map((x) => ({ tags: $$('.tag', x).map((t) => t.textContent), text: x.textContent }));`);
  const merged = wt.find((x) => x.tags.includes('merged'));
  const unmerged = wt.find((x) => x.tags.includes('not merged'));
  check('a worktree says it merged into the trunk, what was skipped and what was taken', Boolean(merged) && /Merged into main · \d+ files: \d+ the same as main, skipped · took 1: src\/reader-themes\.ts \(uncommitted change\)/.test(merged.text), merged?.text.slice(0, 300));
  check('a worktree says it did not merge, how many commits the trunk lacks and what it adds', Boolean(unmerged) && /Not merged into main: 1 commit main does not have/.test(unmerged.text) && /took 2: src\/export-attachments\.ts \(changed on branch\), src\/export-images\.ts \(uncommitted change\)/.test(unmerged.text), unmerged?.text.slice(0, 340));
  await page(`$('#in-scope .scope-item:nth-of-type(2)')?.scrollIntoView({ block: 'center' }); return true;`);
  await b.shot(join(outDir, '01-scope-worktrees.png'));

  const coverBtn = await page(`
    const all = $$('#main .scope-item').flatMap((x) => $$('button.text-btn', x).filter((bt) => bt.previousSibling?.textContent?.trim() === 'Covered by' || bt.parentElement?.textContent.startsWith('Covered by')));
    const archive = all.find((bt) => bt.textContent === 'archive/ holds v1 designs and is not current material');
    if (archive) { archive.scrollIntoView({ block: 'center' }); archive.click(); }
    return { found: Boolean(archive) };`);
  await settle(400);
  const ruleRow = await page(`const el = document.getElementById('rule-rule_archive'); return el ? { visible: el.getClientRects().length > 0, flash: el.classList.contains('flash'), text: el.textContent.slice(0, 120) } : null;`);
  check('a covered location opens its rule in How this project works', coverBtn.found && ruleRow?.visible, JSON.stringify({ found: coverBtn.found, ruleRow }));

  const toolchain = await page(`const s = $('#toolchain'); return s ? { text: s.textContent, entries: $$('.stack', s).length, tags: $$('.tag', s).map((t) => t.textContent) } : null;`);
  check('the toolchain lists a used entry and a too-broad one, each with its config item and why', Boolean(toolchain) && toolchain.entries === 2 && /local\.properties declares sdk\.dir/.test(toolchain.text) && /local\.properties declares toolchain\.home/.test(toolchain.text) && /too broad \(it contains the project directory\)/.test(toolchain.text) && toolchain.tags.includes('used') && toolchain.tags.includes('listed, not used'), toolchain?.text.slice(0, 300));
  check('the toolchain says the Keeper may read it for the build environment, and the owner corrects through Ask Keeper', Boolean(toolchain) && /Keeper may read them to make sense of the build environment/.test(toolchain.text) && /Ask Keeper/.test(toolchain.text), toolchain?.text.slice(0, 240));
  await page(`$('#toolchain')?.scrollIntoView({ block: 'center' }); return true;`);
  await b.shot(join(outDir, '02-toolchain.png'));

  // The organizing levels are the product's own count from the rounds the fixture plants (Spec §1.11; CKC-13 AC-8; QC
  // AY): the served workbench computes them again from the assets, and the table shows them level by level. The fixture
  // makes three of them known: the supplier's two documents settled by their rule, the owner's three drafted
  // conversations taken for their conclusions, the research notes read while the deepening ran and not yet organized.
  const levels = await page(`const tables = $$('#coverage table.list'); const levelRows = tables.length > 1 ? $$('tbody tr', tables[1]).map((r) => [...r.children].map((c) => c.textContent)) : []; return { levelRows, settled: $('#coverage')?.textContent.match(/Settled by rule \\((\\d+)\\)/)?.[1] ?? null, supplier: $('#coverage')?.textContent.includes('供应商提供的文档只作参考') };`);
  const apiLevels = (summary.coverage.takeover?.levels ?? []).filter((l) => l.materials > 0);
  const levelOf = (name) => apiLevels.find((l) => l.level === name)?.materials ?? 0;
  const shownLevels = levels.levelRows.map(([level, n]) => `${level}:${n}`);
  const wantLevels = apiLevels.map((l) => `${l.level}:${l.materials}`);
  check('the coverage shows the organizing levels the product counted, level by level, none of them empty', apiLevels.length >= 4 && JSON.stringify(shownLevels) === JSON.stringify(wantLevels) && levelOf('Read in full') > 0 && levelOf('Indexed') > 0,
    `shown ${shownLevels.join(' · ')} · counted ${wantLevels.join(' · ')}`);
  check('the levels are the planted material’s: 2 settled by rule, 3 drafted sessions as conclusions only, 1 file not organized yet', levelOf('Settled by rule') === 2 && levelOf('Conclusions only') === 3 && levelOf('Not organized') === 1,
    `settled ${levelOf('Settled by rule')} · conclusions ${levelOf('Conclusions only')} · not organized ${levelOf('Not organized')}`);
  check('the coverage counts the Settled by rule level, agrees with what Project scope says the rules settle, and names the rule', levelOf('Settled by rule') === scopeData.settledByRule?.materials && levels.settled === String(levelOf('Settled by rule')) && levels.supplier,
    `level ${levelOf('Settled by rule')} · Project scope ${scopeData.settledByRule?.materials} · block ${levels.settled}`);
  // Beside the levels, what was read only in part (CKC-13 AC-8): §1.11 has no level for it, so it is a line, not a row.
  const coveragePart = await page(`return $('#coverage .read-in-part')?.textContent ?? '';`);
  const partCounted = summary.coverage.takeover?.readInPart ?? null;
  check('the coverage says beside its levels what was read only in part, as the product counted it, and adds no level',
    Boolean(partCounted?.materials) && coveragePart.startsWith(`Read in part: ${partCounted.materials} material`) && !shownLevels.some((l) => /^Read in part/.test(l)), coveragePart);
  await page(`$('#coverage')?.scrollIntoView({ block: 'start' }); return true;`);
  await b.shot(join(outDir, '03-coverage-settled.png'));

  // The sources list filters by organizing level, its options from the vocabulary.
  const filter = await page(`
    const sel = $$('#sources select').find((s) => $$('option', s).some((o) => o.textContent === 'Settled by rule'));
    if (!sel) return { found: false };
    const options = $$('option', sel).map((o) => o.textContent);
    sel.value = 'Settled by rule'; sel.dispatchEvent(new Event('change'));
    return { found: true, options };`);
  await b.waitFor(`[...document.querySelectorAll('#sources table.list tbody tr')].length === 2`, { label: 'the two settled sources' });
  const filtered = await page(`return $$('#sources table.list tbody tr').map((r) => r.textContent.slice(0, 60));`);
  check('the sources list filters by organizing level with the vocabulary’s names', filter.found && filter.options.includes('Read in full') && filter.options.includes('Settled by rule') && filtered.every((r) => /Supplier/.test(r)), `${filter.options.length} options · rows: ${filtered.join(' | ')}`);
  await b.shot(join(outDir, '04-sources-level-filter.png'));
  await page(`const sel = $$('#sources select').find((s) => $$('option', s).some((o) => o.textContent === 'Settled by rule')); sel.value = ''; sel.dispatchEvent(new Event('change')); return true;`);
  await settle(500);

  // The Add item dialog offers the two new relations, from the vocabulary.
  await page(`$$('#main .page-head button, #main .row button').find((x) => x.textContent === 'Add item')?.click(); return true;`);
  await b.waitFor("document.querySelector('#dialog')?.open", { label: 'Add item dialog' });
  const relations = await page(`return $$('#dialog select').map((s) => $$('option', s).map((o) => o.value));`);
  check('the Add item dialog offers Third-party material and Generated', relations.some((r) => r.includes('Third-party material') && r.includes('Generated')), JSON.stringify(relations));
  await b.shot(join(outDir, '05-add-item.png'));
  await b.key('Escape');
  await settle(300);

  // Rescan: a new document in the project directory appears after pressing it.
  writeFileSync(join(projectDir, 'docs', 'cdp-probe.md'), '# CDP probe\n\nA document added by the S6 browser check; only a re-read of the disk finds it.\n');
  await page(`$$('#main .page-head button, #main .row button').find((x) => x.textContent === 'Rescan')?.click(); return true;`);
  let probe = false;
  for (let i = 0; i < 60 && !probe; i += 1) {
    await sleep(500);
    probe = (await get('/sources?q=cdp-probe&usedAs=&availability=')).length > 0;
  }
  check('Rescan re-reads the disk: a document added to the project appears in the sources', probe, probe ? 'found via the sources API' : 'not found within 30 s');
  await goView('notes', 'Notes log');   // away and back: the sources list is read again on a fresh render
  await goView('scope', 'Project scope');
  const probeRow = await page(`return $$('#sources table.list tbody tr').filter((r) => /CDP probe/.test(r.textContent)).length;`);
  check('the probe shows in the sources list of Project scope', probeRow === 1, `rows: ${probeRow}`);
  await page(`$$('#sources table.list tbody tr').find((r) => /CDP probe/.test(r.textContent))?.scrollIntoView({ block: 'center' }); return true;`);
  await b.shot(join(outDir, '06-rescan-probe.png'));

  // What the ledger keeps without reading it (ScopeKView ledger.notRead; QC AY B13): the review tool's binary export of a
  // receipt, committed on a branch nobody merged. The fixture's ledger counts it; the page says it with the size the
  // ledger reads to, the path, that it is a report whose verdicts are not read, and what that means — the ledger's words.
  const nr = (await get('/scope-k')).ledger?.notRead ?? null;
  await b.waitFor("document.querySelector('.kv-scope .kv-notread')", { label: 'what the ledger keeps without reading' });
  const notRead = await page(`const d = $('.kv-notread'); return { dt: d.previousElementSibling?.textContent ?? '', versions: d.querySelector('[data-part="versions"] > div')?.textContent ?? '', paths: $$('[data-list="versions"] li', d).map((li) => li.textContent), reports: d.querySelector('[data-part="reports"]')?.textContent ?? '', effect: d.querySelector('[data-part="effect"]')?.textContent ?? '' };`);
  check('Project scope says what the ledger keeps without reading: 1 version kept without its text, over 4 MB or not text, its path, a report whose verdicts are not read, and what that means',
    Boolean(nr) && nr.versionsWithoutText === 1 && JSON.stringify(nr.paths) === JSON.stringify(['docs/receipts/batch-0.md']) && nr.reports.includes('docs/receipts/batch-0.md') && nr.documentLimitBytes === 4_000_000
      && notRead.dt === 'Kept without reading' && notRead.versions === '1 document version kept without its text — over 4 MB, or not text:' && JSON.stringify(notRead.paths) === JSON.stringify(nr.paths)
      && notRead.reports === 'A report among them, whose verdicts are not read: docs/receipts/batch-0.md' && notRead.effect === nr.effect,
    `${notRead.versions} ${notRead.paths.join(', ')} · ${notRead.reports}`);
  await page(`$('.kv-notread')?.scrollIntoView({ block: 'center' }); return true;`);
  await b.shot(join(outDir, '06b-ledger-kept-without-reading.png'));
  await noScroll('Project scope');

  // ── Keeper: the owner's-words step, the settled level, the boundary denials (Spec §3.7, §1.11; CKC-03 AC-23) ──
  // The owner's-words step is counted by the product from the planted first usable round (D37): its session-drafts steps
  // (how many, how long), the owner's lines their drafts hold, the owner's messages in the three conversation logs, and
  // the Owner's words items the skeleton wrote. The check holds the page to the product's figures and the figures to the
  // round's own steps.
  await goView('keeper', 'Keeper');
  const takeover = await page(`const s = $('#takeover'); return s ? s.textContent : '';`);
  const ow = summary.coverage.takeover?.firstUsable?.ownerWords ?? null;
  const firstRound = (await get('/k-rounds')).find((r) => r.kind === 'First usable');
  const draftSteps = (firstRound?.steps ?? []).filter((s) => s.kind === 'session-drafts');
  const draftSpan = draftSteps.length ? Math.round((Math.max(...draftSteps.map((s) => Date.parse(s.endedAt))) - Math.min(...draftSteps.map((s) => Date.parse(s.startedAt)))) / 60_000) : null;
  const owLine = ow ? `read ${ow.utterances} of ${ow.total} of the owner’s messages (${ow.chars} of ${ow.totalChars} chars) in ${ow.calls} call${ow.calls === 1 ? '' : 's'} · wrote ${ow.items} Owner’s words items` : null;
  check('the owner’s-words step’s figures are the first usable round’s: its two draft calls over four minutes, 12 of the owner’s 12 messages, the 9 Owner’s words items it wrote', Boolean(ow) && ow.calls === draftSteps.length && ow.calls === 2 && ow.minutes === draftSpan && ow.minutes === 4 && ow.utterances === 12 && ow.total === 12 && ow.items === 9 && ow.chars > 0 && ow.chars === ow.totalChars,
    ow ? `${ow.calls} calls (${draftSteps.length} draft steps) · ${ow.minutes} min (steps span ${draftSpan}) · ${ow.utterances} of ${ow.total} · ${ow.chars} of ${ow.totalChars} chars · ${ow.items} items` : 'no owner’s-words step in the coverage');
  check('the takeover progress gives the owner’s-words step with those figures', Boolean(owLine) && new RegExp(`Owner’s words step: .+ · ${owLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · .+ – .+`).test(takeover), takeover.match(/Owner’s words step[^\n]*?(?=Organizing levels|Remaining|What a Full|$)/)?.[0]?.slice(0, 260) ?? takeover.slice(0, 200));
  check('the takeover progress counts the Settled by rule level and names the rule', /Settled by rule/.test(takeover) && /Settled by rule \(2\)/.test(takeover) && /供应商提供的文档只作参考，不作需求依据/.test(takeover), takeover.slice(takeover.indexOf('Organizing levels'), takeover.indexOf('Organizing levels') + 400));
  await page(`$('#takeover')?.scrollIntoView({ block: 'start' }); return true;`);
  await b.shot(join(outDir, '07-keeper-takeover.png'));

  // The depth question counts each path by the question list and says how (DeepeningPlan.paths[].basis; QC AY B13): three
  // from what their briefs name, and the kind no brief covers yet from the ledger's totals — the deepening sends a lane
  // for each kind of question (CKC-23 AC-4; D99). Each row of the paths says it, as the product computed it.
  const apiPaths = summary.coverage.takeover?.deepening?.paths ?? [];
  const shownPaths = await page(`return { head: $$('#takeover table.deepening-paths thead th').map((th) => th.textContent), rows: $$('#takeover table.deepening-paths tbody tr').map((r) => ({ path: r.dataset.path, basis: r.querySelector('.path-basis')?.textContent ?? null })) };`);
  check('the depth question’s paths each say how their amount was counted: three by what their briefs name, the kind no brief covers yet by the ledger’s totals',
    apiPaths.length === 4 && shownPaths.head.includes('How it was counted') && JSON.stringify(shownPaths.rows) === JSON.stringify(apiPaths.map((p) => ({ path: p.path, basis: p.basis })))
      && apiPaths.filter((p) => p.basis === 'counted from what its brief names').length === 3 && apiPaths[3].path === 'The code as it stands (no brief covers it yet)' && /no brief covers it yet, and the deepening sends a lane for each kind of question/.test(apiPaths[3].basis),
    shownPaths.rows.map((p) => `${p.path}: ${p.basis}`).join(' | '));

  // The deepening the main agent ran (D99; Spec §3.7 stage 4, §6.9): its progress is by lane — what each answers, the slots
  // it writes, its status, its time and what it read, counted from its recorded reads — and by the coverage check's state.
  const deepen = (await get('/k-rounds')).find((r) => r.kind === 'Deepen');
  const shownLanes = await page(`return { head: $$('#takeover table.deepening-by-lane thead th').map((th) => th.textContent), main: $('#takeover .deepening-main')?.dataset.stage ?? null, rows: $$('#takeover table.deepening-by-lane tbody tr[data-lane]').map((r) => ({ lane: r.dataset.lane, kind: r.dataset.kind, slots: r.children[2]?.textContent ?? '', read: r.querySelector('.lane-read')?.textContent ?? '' })), coverage: $('#takeover .deepening-coverage')?.dataset.settled ?? null };`);
  const readText = (r) => { const parts = [r.files ? `${r.files} file${r.files === 1 ? '' : 's'}` : null, r.versions ? `${r.versions} version${r.versions === 1 ? '' : 's'}` : null, r.commits ? `${r.commits} commit${r.commits === 1 ? '' : 's'}` : null, r.sessions ? `${r.sessions} session${r.sessions === 1 ? '' : 's'}` : null].filter(Boolean); return parts.length ? parts.join(' · ') : 'nothing recorded'; };
  const wantLanes = (deepen?.lanes ?? []).map((l) => ({ lane: l.name, kind: l.kind, slots: l.slots.join(', ') || '—', read: readText(l.read) }));
  check('the deepening’s progress gives each lane as the round records it: what it answers, the slots it writes, what it read; the main agent’s stage and the coverage check’s state',
    Boolean(deepen?.main) && shownLanes.head.join('|') === 'Lane|Answers|Slots|Status|Time|Read' && JSON.stringify(shownLanes.rows) === JSON.stringify(wantLanes)
      && wantLanes.length === 4 && wantLanes.some((l) => l.lane === 'The code as it stands') && shownLanes.main === deepen.main.stage && shownLanes.coverage === String(deepen.coverage?.settled),
    shownLanes.rows.map((r) => `${r.lane} [${r.kind}] ${r.slots}: ${r.read}`).join(' | '));
  const asRun = await page(`const r = $('#takeover tr.as-run'); return r ? { depth: r.dataset.depth, after: r.previousElementSibling?.dataset.depth ?? null, reads: r.querySelector('.as-run-reads')?.textContent ?? '' } : null;`);
  check('the deepening as it ran stands beside the estimate of the depth it ran at: its lanes, what they read, its coverage check',
    Boolean(asRun) && asRun.depth === summary.coverage.takeover.depth && asRun.after === asRun.depth && asRun.reads.startsWith(`${wantLanes.length} lanes read `) && asRun.reads.includes('coverage check:'),
    asRun ? `${asRun.depth}, after ${asRun.after}: ${asRun.reads}` : 'no as-run row');
  const readInPart = summary.coverage.takeover?.readInPart ?? null;
  const besideLevels = await page(`return { part: $('#takeover .read-in-part')?.textContent ?? '', history: $('#takeover .history-not-organized')?.textContent ?? '' };`);
  check('beside the levels: the materials read only in part, each at its level, and the older material not organized, as the product counted them',
    Boolean(readInPart?.materials) && besideLevels.part.startsWith(`Read in part: ${readInPart.materials} material`) && Object.entries(readInPart.byLevel).every(([l, n]) => besideLevels.part.includes(`${l} ${n}`))
      && besideLevels.history.startsWith(`Older material not organized: ${summary.coverage.takeover.historyNotOrganized || 'none'}`),
    `${besideLevels.part} · ${besideLevels.history}`);
  await page(`$('#takeover .deepening-lanes')?.scrollIntoView({ block: 'start' }); return true;`);
  await b.shot(join(outDir, '07c-deepening-as-run.png'));

  // The round tree: the deepening's main agent with its stages, each lane under it with its brief and report, and the
  // coverage check with what no lane read and each account beside it (Spec §6.9). No reading assignments or sweeps.
  const tree = await page(`const r = $('.kv-round[data-kind="Deepen"]'); if (!r) return null; return {
    stages: $$('.kv-stages tbody tr', r).map((e) => e.dataset.stage + ':' + e.dataset.ran),
    lanes: $$('.kv-lane', r).map((e) => ({ lane: e.dataset.lane, docs: $$('.kv-docs button', e).map((x) => x.dataset.kind) })),
    settled: $('.kv-coverage', r)?.dataset.settled ?? null,
    untouched: $$('.kv-coverage .kv-untouched li', r).length,
    accounted: $$('.kv-coverage .kv-accounted:not(.kv-untouched) li', r).map((e) => e.dataset.outcome),
    old: $$('.kv-step[data-kind="dig"], .kv-assignment, .kv-dig-path, .kv-sweeps-added', r).length,
  };`);
  check('the round tree shows the deepening’s stages, each lane with its brief and report, and the coverage check with what no lane read and each account',
    Boolean(tree) && tree.stages.join(',') === 'orientation:yes,dig:yes,coverage:yes,cross-check:yes,synthesis:yes' && tree.lanes.length === 4 && tree.lanes.every((l) => l.docs.join('+') === 'Brief+Report')
      && tree.settled === 'true' && tree.untouched === (deepen?.coverage?.untouched ?? []).length && JSON.stringify(tree.accounted) === JSON.stringify((deepen?.coverage?.accounted ?? []).map((a) => a.outcome)) && tree.old === 0,
    tree ? `${tree.stages.join(',')} · ${tree.lanes.map((l) => `${l.lane} ${l.docs.join('+')}`).join(' | ')} · untouched ${tree.untouched}, accounted ${tree.accounted.join(',')}` : 'no Deepen round in the tree');
  await page(`const d = $('.kv-round[data-kind="Deepen"] .kv-coverage .kv-accounted'); if (d) d.open = true; d?.scrollIntoView({ block: 'center' }); return true;`);
  await b.shot(join(outDir, '07d-round-tree-coverage.png'));

  const activity = await page(`return $$('#keeper-activity tbody tr').map((r) => ({ label: r.textContent.slice(0, 90), denial: (r.textContent.match(/\\d+ reads? outside the boundary denied( · \\d+ with subagents)?/g) ?? []) }));`);
  const deniedRows = activity.filter((r) => r.denial.length > 0);
  check('a job row shows the reads the boundary refused (only above zero)', deniedRows.length === 2 && deniedRows.every((r) => r.denial[0].startsWith('1 read outside the boundary denied')), deniedRows.map((r) => `${r.label.slice(0, 40)} → ${r.denial[0]}`).join(' | '));
  await page(`$$('#keeper-activity tbody tr').find((r) => /outside the boundary denied/.test(r.textContent))?.scrollIntoView({ block: 'center' }); return true;`);
  await b.shot(join(outDir, '08-keeper-activity-denials.png'));
  await noScroll('Keeper');

  // ── Follow up: what a round made new, where it is and a press away; the last round found nothing, and the top bar says so
  // (Spec §3.8, §6.2; D79; CKC-07 AC-27; CKC-24 AC-15; QC AY B2). The fixture plants three Follow up results: round 1 from
  // before rounds counted their news (objects left behind), round 3 with news of every kind, and round 4 — the last —
  // which found nothing new. Every figure is the product's own count (round-news.ts), read back from the served API.
  await b.evaluate(`location.hash = ${JSON.stringify(url('graph').split('#')[1])}`);
  await b.waitFor("document.querySelector('#cy canvas') && document.querySelector('.strip')", { label: 'the Project graph and its strip' });
  await settle(900);
  const ov = await get('/overview?since=&selection=');
  const lastRound = summary.coverage.lastFollowUp ?? null;
  const roundItems = ov.needsYou.filter((x) => x.kind === 'round');
  const newsItem = roundItems.find((x) => x.news) ?? null;
  const earlier = roundItems.filter((x) => !x.news);
  const news = newsItem?.news ?? null;
  const KINDS = [['breakpoints', 'Breakpoints newly lit'], ['sendbacks', 'Send-backs new or moved'], ['sixThings', 'Newly among the six things'], ['patches', 'Semantic patches confirmed'], ['notes', 'Notes written or updated']];

  const top = await page(`const pill = $('.coverage-pill'); const acts = $('.top-actions'); const last = pill?.querySelector('.cov-last-round'); const r = (e) => e.getBoundingClientRect(); return { statement: last?.textContent ?? null, inPill: Boolean(last), pillH: pill ? r(pill).height : 0, actionsH: acts ? r(acts).height : 0, inBar: Boolean(last?.closest('.topbar')), scrollW: document.documentElement.scrollWidth, innerW: innerWidth };`);
  check('the last Follow up round found nothing new, and the top bar says so where it shows the coverage — on a line of its own, the buttons on one row',
    Boolean(lastRound?.nothingNew) && lastRound.round === 4 && lastRound.statement === 'The last Follow up round found nothing new' && top.statement === lastRound.statement && top.inPill && top.inBar && top.actionsH <= top.pillH + 2 && top.scrollW <= top.innerW,
    `${top.statement} · round ${lastRound?.round} · pill ${Math.round(top.pillH)}px, actions row ${Math.round(top.actionsH)}px`);
  check('a round that found nothing new has no item in Notes (attention); the round with news has one, named by its number among the rounds, saying what it made new',
    roundItems.length === 2 && !roundItems.some((x) => x.id === lastRound?.recordId) && Boolean(newsItem) && newsItem.roundName === 'Follow up round 3' && newsItem.label === `Follow up round 3: ${news.statement}` && !news.nothingNew && news.complete
      && await page(`return Boolean($('.strip section[data-col="attention"] [data-row="round:${newsItem?.id}"]')) && !$('.strip section[data-col="attention"] [data-row="round:${lastRound?.recordId}"]');`),
    newsItem?.label ?? 'no Follow up item with news');
  const why = await page(`return $('.strip section[data-col="attention"] .strip-why small')?.textContent ?? '';`);
  check('the header of Notes (attention) says what the Follow up item is now: a result with something new; an earlier one, with objects still behind',
    why.includes('1 Follow up result with something new.') && why.includes('1 Follow up result from before rounds counted what they found new, with objects still on the old understanding.') && !why.includes('something for you to settle'), why.slice(why.indexOf('Follow up') - 2, why.indexOf('Follow up') + 190));
  // QC AH #11: the header counts the Follow up results listed, apart from the notes (§6.2, §2.4) — in its card, where the
  // owner put the other counts (2026-09-22).
  const counted = await page(`const h = $('.strip section[data-col="attention"] header'); return { count: $('.strip-title small', h)?.textContent ?? '', also: $$('.strip-why span', h).map((x) => x.textContent).find((t) => t.startsWith('Also here')) ?? '', listed: $$('.strip section[data-col="attention"] [data-row^="round:"]').length };`);
  check('the header counts the Follow up results listed in Notes (attention) apart from the note count',
    counted.listed === roundItems.length && counted.also.includes(`${roundItems.length} Follow up result${roundItems.length === 1 ? '' : 's'}`) && !/Follow up/.test(counted.count), `${counted.count} · ${counted.also} · ${counted.listed} listed`);

  // QC AH #11: `Since last visit` sums up each Follow up round since the owner's last visit, one row each, in the order they
  // ended — first in the column, each the row `Notes (attention)` gives the round — including the one that found nothing
  // new. The figures are the product's own summary for the page's last visit.
  const lastVisit = await page(`return (await import('/app.js')).state.lastVisit;`);
  const sinceRounds = (await get(`/overview?since=${encodeURIComponent(lastVisit ?? '')}&selection=`)).sinceLastVisit?.rounds ?? [];
  const sinceShown = await page(`return $$('.strip section[data-col="since"] .strip-row').map((r) => ({ key: r.dataset.row, text: r.querySelector('.row-text')?.textContent ?? '', mark: r.querySelector('.mk')?.title ?? '' }));`);
  check('Since last visit sums up each Follow up round since the last visit, one row each, first in the column and in the order they ended — the one that found nothing new too',
    sinceRounds.length === 3 && JSON.stringify(sinceShown.slice(0, 3).map((r) => r.key)) === JSON.stringify(sinceRounds.map((r) => `round:${r.id}`)) && sinceShown.slice(0, 3).every((r, i) => r.text === sinceRounds[i].label && r.mark.startsWith('Follow up result'))
      && sinceRounds.some((r) => r.news?.nothingNew) && sinceRounds.some((r) => !r.news) && !sinceShown.slice(3).some((r) => r.key.startsWith('round:')),
    sinceShown.slice(0, 3).map((r) => r.text.slice(0, 70)).join(' | '));
  await page(`$('.strip section[data-col="since"] .items').scrollTop = 0; return true;`);
  await b.shot(join(outDir, '09a-since-last-visit-rounds.png'));

  // The earlier round's item keeps the display it had: its sentence, the result's account, and the way to the result.
  const closeSheet = async () => { if (await page(`return Boolean($('.strip-sheet'));`)) { await b.clickOn('.strip-sheet-close'); await b.waitFor("!document.querySelector('.strip-sheet')"); await settle(200); } };
  await b.clickOn(`.strip section[data-col="attention"] [data-row="round:${earlier[0]?.id}"] > .item`, { scroll: true });
  await b.waitFor("document.querySelector('.strip-sheet-body')", { label: 'the earlier round in the reading sheet' });
  await settle(300);
  const olderSheet = await page(`const m = $('.strip-sheet-body'); return { text: m.textContent, news: Boolean(m.querySelector('.round-news')), buttons: $$('button', m).map((x) => x.textContent) };`);
  check('the Follow up result from before rounds counted their news opens as it always did: its sentence, the result’s account, Open the result',
    earlier.length === 1 && earlier[0].label === 'Follow up round 1: 2 objects still on the old understanding, 1 with no holder' && olderSheet.text.includes(earlier[0].label) && olderSheet.text.includes(earlier[0].detail) && !olderSheet.news && olderSheet.buttons.includes('Open the result'),
    earlier[0]?.label ?? 'none');
  await closeSheet();

  // The round with news, opened: the five kinds in order, each entry what it is, where it is, and what changed for it.
  const openNews = async () => {
    await page(`const d = $('#dialog'); if (d?.open) d.close(); return true;`);
    if (!(await page(`return $('#popover').hidden;`))) { await b.key('Escape'); await settle(200); }
    if (await page(`return Boolean($('#k-code'));`)) {
      await page(`$$('.topbar button').find((x) => x.textContent.trim() === 'Graph')?.click(); return true;`);
      await b.waitFor("document.querySelector('#cy canvas') && document.querySelector('.strip')", { label: 'back on the graph' });
      await settle(700);
    }
    await closeSheet();
    await b.clickOn(`.strip section[data-col="attention"] [data-row="round:${newsItem.id}"] > .item`, { scroll: true });
    await b.waitFor("document.querySelector('.strip-sheet .round-news')", { label: 'the round’s news in the reading sheet' });
    await settle(400);
  };
  await openNews();
  const sheet = await page(`const s = $('.strip-sheet'); return { title: s.querySelector('.strip-sheet-body > .more-title')?.textContent ?? '', kinds: $$('.news-kind', s).map((k) => ({ kind: k.dataset.news, head: k.querySelector('h4').textContent, items: $$('li', k).map((li) => ({ id: li.dataset.newsId, go: li.dataset.go, label: (li.querySelector('.news-go') ?? li.querySelector('.news-label'))?.textContent ?? '', position: li.querySelector('.news-pos')?.textContent ?? '', detail: (li.querySelector('.news-detail') ?? li.querySelector('.news-why'))?.textContent ?? null })) })), buttons: $$('.more-actions button', s).map((x) => x.textContent) };`);
  const want = KINDS.filter(([k]) => news[k].length).map(([k, t]) => ({ kind: k, head: `${t} (${news[k].length})`, items: news[k].map((i) => ({ id: i.id, go: i.go?.to ?? '', label: i.label, position: i.position, detail: i.detail })) }));
  check('opened, the round lists its news by kind — breakpoints newly lit, send-backs new or moved, newly among the six things, semantic patches confirmed, notes written or updated — each with its position and what changed',
    want.length === 5 && sheet.title === newsItem.label && JSON.stringify(sheet.kinds) === JSON.stringify(want) && news.sendbacks.some((i) => i.detail === 'new · Suggested') && news.sendbacks.some((i) => i.detail === 'Suggested → Returned') && sheet.buttons.includes('Open the result'),
    sheet.kinds.map((k) => `${k.head}: ${k.items.map((i) => `${i.label.slice(0, 40)} @ ${i.position.slice(0, 30)}`).join('; ')}`).join(' | ').slice(0, 400));
  check('every entry has a way there: the process view, Code, the note or the patch', want.flatMap((k) => k.items).every((i) => i.go) && ['process', 'code', 'note', 'patch'].every((to) => want.some((k) => k.items.some((i) => i.go === to))),
    want.flatMap((k) => k.items.map((i) => `${k.kind}:${i.go}`)).join(' '));
  await b.shot(join(outDir, '09-follow-up-news.png'));

  // Each jump goes where the entry says it is.
  const entryOf = (to) => { for (const [k] of KINDS) { const i = news[k].find((x) => x.go?.to === to); if (i) return { kind: k, item: i }; } return null; };
  const press = async (to) => {
    await openNews();
    const e = entryOf(to);
    await b.clickOn(`.strip-sheet .news-kind[data-news="${e.kind}"] li[data-news-id="${e.item.id}"][data-go="${to}"] .news-go`, { scroll: true });
    return e.item;
  };
  const pWork = await press('process');
  await b.waitFor(`(async () => !document.querySelector('#popover').hidden && (await import('/app.js')).state.selection?.id === ${JSON.stringify(pWork.go.id)})()`, { label: 'the work’s popover' });
  await settle(500);
  const atWork = await page(`const app = await import('/app.js'); return { sel: app.state.selection, view: app.state.view, mode: app.state.graphMode, sheet: Boolean($('.strip-sheet')), title: $('#popover .popover-title')?.textContent ?? '' };`);
  check('a breakpoint’s entry goes to its work in the process view: the work picked on the graph, its popover open, the sheet closed',
    atWork.sel?.kind === 'node' && atWork.sel.id === 'thread_search_index' && atWork.view === 'graph' && (atWork.mode ?? 'graph') === 'graph' && !atWork.sheet && atWork.title.includes('Search index incremental rebuild'), `${atWork.sel?.id} · ${atWork.title} · view ${atWork.view} · mode ${atWork.mode ?? 'graph'} · sheet ${atWork.sheet}`);
  await b.shot(join(outDir, '10-news-to-work.png'));
  const pTerritory = await press('code');
  await b.waitFor("document.querySelector('#k-code tr.kv-target')", { label: 'the territory in Code' });
  await settle(400);
  const atCode = await page(`const row = $('#k-code tr.kv-target'); return { terr: row?.dataset.terr ?? null, drilled: Boolean($('#k-code tr.kv-drill[data-tid="' + (row?.dataset.terr ?? '') + '"]')), anomaly: row?.querySelector('.kv-anomaly')?.dataset.kind ?? null };`);
  check('a code anomaly’s entry goes to its territory in Code: the row brought into view, marked, its files open', pTerritory.go.id === 'terr_sync' && atCode.terr === 'terr_sync' && atCode.drilled && atCode.anomaly === 'Unreferenced', JSON.stringify(atCode));
  await b.shot(join(outDir, '11-news-to-code.png'));
  const pNote = await press('note');
  await b.waitFor(`!document.querySelector('#popover').hidden && document.querySelector('#popover .popover-title')?.textContent === ${JSON.stringify(pNote.go.label)}`, { label: 'the note' });
  const atNote = await page(`const app = await import('/app.js'); return { sel: app.state.selection, sheet: Boolean($('.strip-sheet')) };`);
  check('a note’s entry opens the note', atNote.sel?.kind === 'note' && atNote.sel.id === 'note_zh_search' && !atNote.sheet, `${atNote.sel?.kind} ${atNote.sel?.id}`);
  await b.key('Escape');
  await settle(300);
  const pPatch = await press('patch');
  await b.waitFor("document.querySelector('#dialog').open && document.querySelector('#dialog .kp-patch-four')", { label: 'the patch' });
  const atPatch = await page(`return $('#dialog-title')?.textContent ?? '';`);
  check('a semantic patch’s entry opens the patch: what no longer holds, what replaced it, who is affected', pPatch.go.id === 'sp_tag_browser' && atPatch.startsWith('SP-1 · The tag browser is withdrawn'), atPatch);
  await page(`$('#dialog').close(); return true;`);
  await settle(300);

  // The result, from the item: named as the item names it, with the news counts and the news; opening it is the owner
  // looking, and the item leaves Notes (attention) (D56 item 3).
  await openNews();
  await b.clickOn('.strip-sheet .more-foot .more-actions button', { scroll: true });
  await b.waitFor("document.querySelector('#dialog').open && document.querySelector('#dialog .round-news')", { label: 'the round’s result' });
  await settle(300);
  const result = await page(`return { title: $('#dialog-title')?.textContent ?? '', counts: $$('#dialog .news-count').map((t) => t.textContent), kinds: $$('#dialog .news-kind').map((k) => k.dataset.news) };`);
  const c = (await get('/rounds')).rounds.find((r) => r.id === newsItem.id)?.result?.counts?.news ?? null;
  check('Open the result: the round named as its item names it, the news counted beside the rest, and the news with their jumps',
    result.title === 'Follow up round 3' && Boolean(c) && JSON.stringify(result.counts) === JSON.stringify([`${c.breakpoints} breakpoint newly lit`, `${c.sendbacksNew} new send-back`, `${c.sendbacksMoved} send-back moved`, `${c.sixThings} newly among the six things`, `${c.patches} semantic patch confirmed`, `${c.notes} note written or updated`]) && JSON.stringify(result.kinds) === JSON.stringify(KINDS.map(([k]) => k)),
    `${result.title} · ${result.counts.join(' · ')}`);
  await b.shot(join(outDir, '12-follow-up-result.png'));
  await page(`$('#dialog').close(); return true;`);
  await b.waitFor(`!document.querySelector('.strip section[data-col="attention"] [data-row="round:${newsItem.id}"]')`, { label: 'the opened result leaving Notes (attention)', timeout: 8000 });
  check('once opened, the Follow up result leaves Notes (attention)', !(await page(`return Boolean($('.strip section[data-col="attention"] [data-row="round:${newsItem.id}"]'));`)), '');

  // ── QC AH #11: a round's result stays reachable after it has been seen; AH #6: an object says what it still lacks ──
  // From `Since last visit`: the round's row is still there, opens in place, and opens the result again — without
  // stamping the record a second time.
  const seenAt = (await get('/rounds')).rounds.find((r) => r.id === newsItem.id)?.seenAt ?? null;
  const sinceRow = `.strip section[data-col="since"] [data-row="round:${newsItem.id}"]`;
  const stillInSince = await page(`return Boolean($('${sinceRow}'));`);
  await closeSheet();
  await b.clickOn(`${sinceRow} > .item`, { scroll: true });
  await b.waitFor("document.querySelector('.strip-sheet .round-news')", { label: 'the seen round in the reading sheet' });
  await settle(300);
  await b.clickOn('.strip-sheet .more-foot .more-actions button', { scroll: true });
  await b.waitFor("document.querySelector('#dialog').open && document.querySelector('#dialog .round-news')", { label: 'the seen round’s result, again' });
  await settle(300);
  const again = await page(`return { title: $('#dialog-title')?.textContent ?? '', kinds: $$('#dialog .news-kind').map((k) => k.dataset.news), jumps: $$('#dialog .news-go').length };`);
  await page(`$('#dialog').close(); return true;`);
  await settle(400);
  const seenAtAfter = (await get('/rounds')).rounds.find((r) => r.id === newsItem.id)?.seenAt ?? null;
  check('once seen, a round’s result stays reachable: its row stays in Since last visit and opens the result again, which leaves the record as it was',
    Boolean(seenAt) && stillInSince && again.title === 'Follow up round 3' && JSON.stringify(again.kinds) === JSON.stringify(KINDS.map(([k]) => k)) && again.jumps > 0 && seenAtAfter === seenAt,
    `in Since last visit: ${stillInSince} · ${again.title} · ${again.kinds.length} kinds, ${again.jumps} jumps · seen ${seenAt} → ${seenAtAfter}`);
  await b.shot(join(outDir, '13-since-round-after-seen.png'));
  await closeSheet();

  // An object still on the old understanding (T-28, judged in the first Follow up round): the popover lists what it still
  // lacks, item by item, each with the change it comes from and the round that judged it — as the product read it from
  // the object's latest judgement (graph-view.ts `propagationOf`).
  const lacking = await get('/nodes/thread_tag_suggest');
  const pv = lacking.propagation;
  await page(`const app = await import('/app.js'); app.select({ kind: 'node', id: 'thread_tag_suggest', label: ${JSON.stringify(lacking.node.label)} }); return true;`);
  await b.waitFor("!document.querySelector('#popover').hidden && document.querySelector('#popover .prop-lacks')", { label: 'the popover saying what the object still lacks' });
  await settle(400);
  const lackShown = (sel) => `$$('${sel} .lack').map((l) => ({ change: l.dataset.change, item: l.dataset.item, what: l.querySelector('.lack-what')?.textContent ?? '', from: l.querySelector('.lack-from button')?.textContent ?? '' }))`;
  const lackWant = (pv?.lacks ?? []).map((l) => ({ change: l.changeId, item: l.itemId, what: l.what, from: l.item?.title ?? l.change?.work ?? l.change?.title ?? '' }));
  const pop = await page(`const blk = $('#popover .prop-lacks'); return { head: blk.querySelector(':scope > h4')?.textContent ?? '', lacks: ${lackShown('#popover .prop-lacks')}, judged: blk.querySelector('.judged-in')?.textContent ?? '', inBody: Boolean(blk.closest('.popover-body')) };`);
  check('an object’s popover lists what it still lacks, item by item, each with the change it comes from and the round that judged it',
    pv?.state === 'Still on old understanding' && pv.lacks.length === 1 && pop.inBody && pop.head === `Still on old understanding (${pv.lacks.length})` && JSON.stringify(pop.lacks) === JSON.stringify(lackWant) && pop.judged.startsWith(`Judged in ${pv.round.name}`),
    `${pop.head} · ${pop.lacks.map((l) => `${l.what} ← ${l.from}`).join(' | ')} · ${pop.judged}`);
  await b.shot(join(outDir, '14-popover-still-lacks.png'));
  // `Details`: the Propagation part — the state, the round, what it lacks, the records the state covers.
  await b.clickOn('#popover .popover-foot .btn');
  await b.waitFor("document.querySelector('#dialog').open && document.querySelector('#dialog [data-section=propagation]')", { label: 'the object’s full details' });
  await page(`$('#dialog [data-section=propagation]').scrollIntoView({ block: 'start' }); return true;`);
  await settle(300);
  const full = await page(`const s = $('#dialog [data-section=propagation]'); return { head: s.querySelector(':scope > h4')?.textContent ?? '', state: s.querySelector('.prop-detail > .row .tag')?.textContent ?? '', lacks: ${lackShown('#dialog [data-section=propagation] .prop-lacks')}, covers: $$('.prop-covers .prop-record', s).map((r) => r.dataset.change), atTop: Boolean($('#dialog .full-details > .prop-lacks')) };`);
  check('its full details carry the Propagation part: its state, what it still lacks with the change each comes from, and the records that state covers',
    full.head === `Propagation (${pv.lacks.length})` && full.state === pv.state && JSON.stringify(full.lacks) === JSON.stringify(lackWant) && JSON.stringify(full.covers) === JSON.stringify(pv.covers.map((c) => c.change.id)) && !full.atTop,
    JSON.stringify(full));
  await b.shot(join(outDir, '15-details-propagation.png'));
  // The round that judged it opens its result from here, on top of the details, with a way back.
  await b.clickOn('#dialog [data-section=propagation] .judged-in button', { scroll: true });
  await b.waitFor(`document.querySelector('#dialog-title')?.textContent === ${JSON.stringify(pv.round.name)}`, { label: 'the judging round’s result' });
  const judgedRound = await page(`return { back: $$('#dialog .dialog-head button').some((x) => /Back/.test(x.textContent)), behind: $('#dialog .item')?.textContent ?? '' };`);
  check('the round that judged it opens its result from the object, on top of the details, with a way back', judgedRound.back && judgedRound.behind.length > 0, JSON.stringify(judgedRound));
  await page(`$('#dialog').close(); return true;`);
  await settle(300);
  // Its change opens its record in the Change log.
  await page(`const app = await import('/app.js'); app.select({ kind: 'node', id: 'thread_tag_suggest', label: ${JSON.stringify(lacking.node.label)} }); return true;`);
  await b.waitFor("!document.querySelector('#popover').hidden && document.querySelector('#popover .prop-lacks .lack-from button')", { label: 'the popover again' });
  await b.clickOn('#popover .prop-lacks .lack-from button');
  await b.waitFor(`document.querySelector('#main h1')?.textContent === 'Change log' && document.querySelector('#chg-${pv.lacks[0].changeId}.sel')`, { label: 'the change in the Change log' });
  check('the change a lacked item comes from opens at its record in the Change log', true, pv.lacks[0].changeId);

  // The Keeper view: every finished Follow up round says its result in one line and opens it (§6.9), the seen one too.
  await goView('keeper', 'Keeper');
  const results = (await get('/overview?since=&selection=')).roundResults ?? [];
  await b.waitFor("document.querySelector('.kv-round .kv-round-result')", { label: 'the rounds’ results' });
  const inTree = await page(`return $$('.kv-round').filter((r) => r.querySelector(':scope > .kv-round-result')).map((r) => ({ round: r.dataset.round, result: r.querySelector('.kv-round-result').dataset.result, text: r.querySelector('.kv-round-result > span')?.textContent ?? '' }));`);
  const wantTree = results.filter((x) => x.clerkRoundId).map((x) => ({ round: x.clerkRoundId, result: x.id, text: `Result: ${x.line}` })).reverse();
  check('the Keeper view’s rounds each give a finished Follow up round’s result in one line, with the way to open it',
    inTree.length === 2 && JSON.stringify(inTree) === JSON.stringify(wantTree) && results.find((x) => x.id === newsItem.id)?.seen === true, JSON.stringify(inTree));
  await b.clickOn(`.kv-round[data-round="${results.find((x) => x.id === newsItem.id)?.clerkRoundId}"] .kv-round-result button`, { scroll: true });
  await b.waitFor("document.querySelector('#dialog').open && document.querySelector('#dialog .round-news')", { label: 'the result from the Keeper view' });
  const fromKeeper = await page(`return { title: $('#dialog-title')?.textContent ?? '', kinds: $$('#dialog .news-kind').map((k) => k.dataset.news) };`);
  check('from the Keeper view the seen round’s result opens again, with its news', fromKeeper.title === 'Follow up round 3' && JSON.stringify(fromKeeper.kinds) === JSON.stringify(KINDS.map(([k]) => k)), JSON.stringify(fromKeeper));
  await b.shot(join(outDir, '16-keeper-round-result.png'));
  await page(`$('#dialog').close(); return true;`);
  await b.evaluate(`location.hash = ${JSON.stringify(url('graph').split('#')[1])}`);
  await b.waitFor("document.querySelector('#cy canvas') && document.querySelector('.strip')", { label: 'back on the Project graph' });
  await settle(900);
  await noScroll('Project graph');
  // A narrow window keeps the coverage out of its top bar, as before: the sentence does not bring it back, cut off.
  await b.setViewport(390, 844, true);
  await b.send('Page.reload', { ignoreCache: true });
  await b.waitFor("document.querySelector('#cy canvas') && document.querySelector('.topbar')", { label: 'the narrow Project graph' });
  await settle(700);
  const narrowTop = await page(`const pill = $('.coverage-pill'); return { display: pill ? getComputedStyle(pill).display : 'absent', scrollW: document.documentElement.scrollWidth, innerW: innerWidth };`);
  check('narrow: the top bar leaves the coverage out as it did, the sentence with it, and nothing scrolls sideways', narrowTop.display === 'none' && narrowTop.scrollW <= narrowTop.innerW, JSON.stringify(narrowTop));

  const errors = b.consoleLines.filter((l) => !/wheel sensitivity|font-family/.test(l));
  check('the page reported no error', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  check('the check ran to the end', false, e.message);
  try { await b.shot(join(outDir, 'zz-where-it-stopped.png')); } catch { /* the page is gone */ }
} finally {
  await b.close();
}
const failed = results.filter((r) => !r.ok);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'measurements.json'), JSON.stringify({ at: new Date().toISOString(), base, project: projectId, viewport: '1280x800', checks: results }, null, 2));
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
