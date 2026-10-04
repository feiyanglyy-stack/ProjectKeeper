// §6.17 the Code view: the current version's code territories by product area (CKC-25, §1.19).
// Pure rendering: the CodeView comes in as a parameter; anything more goes through ctx.
import { h, fmtTime } from '../app.js';

const ensureStyle = () => {
  if (document.getElementById('k-views-css')) return;
  const link = document.createElement('link');
  link.id = 'k-views-css';
  link.rel = 'stylesheet';
  link.href = '/k/k-views.css';
  document.head.append(link);
};

const num = (n) => Number(n).toLocaleString('en-US');
const short = (commit) => (commit ? commit.slice(0, 7) : '—');
const day = (occurred) => (occurred && occurred.at ? occurred.at.slice(0, 10) : '—');

// D74/D54: "also serves N" stays one chip; the list opens on hover, and a click pins it open.
const alsoServesChip = (list) => {
  const el = h('span', { class: 'kv-also' },
    h('button', {
      class: 'kv-tag kv-blue', type: 'button',
      onClick: (e) => { e.stopPropagation(); el.classList.toggle('kv-open'); },
    }, `also serves ${list.length}`),
    h('ul', { class: 'kv-also-list' }, list.map((a) => h('li', {}, a.areaName))),
  );
  return el;
};

const terrNames = (ids, byId, counts) => ids.length
  ? ids.map((id) => `${byId.get(id)?.name ?? id}${counts?.[id] != null ? ` (${num(counts[id])})` : ''}`).join(', ')
  : null;

// The work items behind one generation's share of the lines (TerritoryView.generations[].works): one chip, the list
// opens on hover and a click pins it — the same pattern as "also serves N" (D74).
const genWorksChip = (g) => {
  const el = h('span', { class: 'kv-also kv-genworks' },
    h('button', {
      class: 'kv-tag', type: 'button', title: 'Which work items made these lines',
      onClick: (e) => { e.stopPropagation(); el.classList.toggle('kv-open'); },
    }, `${g.works.length} work${g.works.length === 1 ? '' : 's'}`),
    h('ul', { class: 'kv-also-list' }, g.works.map((w) => h('li', {}, `${w.label} · ${num(w.lines)} lines`))),
  );
  return el;
};

/** The anomalies that judge code by its references (§1.19): their `Inferred` is the ledger's reach, not a guess. */
const BY_REFERENCES = new Set(['Unreferenced', 'Looks residual, is live']);

const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

// How deep the ledger reads one language (CodeView.levels; §1.16, §6.17; D98 补), in what was measured: the TypeScript
// compiler's languages to symbols; the code engine's to symbols, with the imports it resolved to a file of the repository
// and those it left unresolved naming one; a language nothing reads, its files and sizes only. Where a file is not read or
// a reference was left unresolved, residual calls there are Inferred; the ledger's own words for that are on hover.
function levelText(l) {
  if (!l.readBy) return 'not read: files and sizes only (residual calls here are Inferred)';
  const measured = [
    l.read < l.files ? `${num(l.read)} of ${num(l.files)} files read` : null,
    l.imports ? `${plural(l.imports.resolved, 'import')} resolved` : null,
    l.imports ? `${num(l.imports.unresolvedNamingRepoFiles)} left unresolved naming a repository file` : null,
    l.namedButUnreferenced ? `${plural(l.namedButUnreferenced, 'file')} named by other files but reached by no counted reference` : null,
    l.parseErrors ? `${plural(l.parseErrors, 'file')} not parsed in full` : null,
  ].filter(Boolean);
  return `read by the ${l.readBy === 'compiler' ? 'TypeScript compiler' : 'code engine'}: symbols${measured.length ? `, ${measured.join(', ')}` : ''}${l.complete ? '' : ' (residual calls here are Inferred)'}`;
}

function anomalyView(a, ctx) {
  const okTone = a.kind === 'Looks residual, is live';
  const sb = a.sendBackId ? ctx.getSendBack?.(a.sendBackId) : null;
  // The notes behind noteIds, by title when the view names them (TerritoryAnomalyView.notes); a bare id otherwise.
  const notes = a.notes?.length ? a.notes : a.noteIds.map((id) => ({ id, title: null, ask: null, status: null }));
  let sbBox = null;
  return h('div', { class: `kv-anomaly ${okTone ? 'kv-ok' : 'kv-lit'}`, dataset: { kind: a.kind } },
    h('div', {},
      h('span', { class: 'kv-kind' }, `${okTone ? '✓' : '⚑'} ${a.kind}`),
      a.basis === 'Inferred' ? h('span', { class: 'kv-tag kv-purple', title: BY_REFERENCES.has(a.kind) ? 'The ledger left references here unresolved, or reads none of them: this call is judged, not computed' : 'Judged from the material, not shown by the ledger alone' }, 'Inferred') : null),
    h('p', { class: 'kv-anomaly-text' }, a.text),
    h('details', { class: 'kv-evid-wrap' },
      h('summary', { class: 'kv-text-btn' }, `basis · ${a.evidence.length}`),
      h('ul', { class: 'kv-evid' }, a.evidence.map((e) => h('li', {},
        h('span', {}, `${e.kind} · ${e.label}`),
        e.line ? h('span', { class: 'kv-line' }, `“${e.line}”`) : null)))),
    h('div', { class: 'kv-anomaly-acts' },
      // From the anomaly to its notes (§6.17 "从异常跳到相关的 note 与送回").
      notes.map((n) => h('button', { class: 'btn small kv-btn kv-note', type: 'button', dataset: { note: n.id }, title: n.title ? `${n.ask ?? 'Note'}${n.status && n.status !== 'Current' ? ` · ${n.status}` : ''} — open the note` : 'Open the note', onClick: () => ctx.openNote(n.id) },
        n.title ? `✎ ${n.title.length > 48 ? `${n.title.slice(0, 47)}…` : n.title}` : 'Note')),
      sb ? (sbBox = h('div', { class: 'kv-sendback', dataset: { sendback: sb.id } },
        h('div', {}, h('span', { class: 'kv-stage' }, `↩ ${sb.stage} · back to ${sb.to}`), h('span', { class: 'kv-muted' }, ` ${sb.suggestion}`)),
        h('div', { class: 'kv-sendback-acts' },
          sb.stage === 'Suggested'
            ? h('button', { class: 'btn small kv-btn', type: 'button', onClick: () => ctx.copy(sb.copyForAgent) }, 'Copy for agent')
            : null,
          // …and to its send-back: the whole of it beside the anomaly — where, the evidence and its lines, where to.
          ctx.openSendBack ? h('button', { class: 'btn small kv-btn kv-open-sb', type: 'button', title: 'Open the send-back: the problem, its evidence and the original lines, where it goes back to', onClick: () => ctx.openSendBack(sb, sbBox) }, 'Open send-back') : null))) : a.sendBackId ? h('span', { class: 'kv-none', title: a.sendBackId }, 'Send-back not found') : null));
}

function drillRow(t, repo, ctx, workLabels) {
  const td = h('td', { colspan: '5' }, h('div', { class: 'kv-doc-loading' }, 'Loading files…'));
  const tr = h('tr', { class: 'kv-drill', dataset: { tid: t.id } }, td);
  const draw = (detail) => {
    td.replaceChildren();
    if (!detail || !detail.files) {
      td.append(h('div', { class: 'kv-none' }, 'No file detail for this territory.'));
      return;
    }
    const refList = (refs) => refs.length === 0
      ? h('span', { class: 'kv-none' }, 'none')
      : h('span', { class: 'kv-reflist', title: refs.join('\n') }, refs.length <= 2 ? refs.map((r) => r.split('/').pop()).join(', ') : `${refs.slice(0, 2).map((r) => r.split('/').pop()).join(', ')} +${refs.length - 2}`);
    td.append(h('table', { class: 'kv-files' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'File'), h('th', {}, 'Lines'), h('th', {}, 'Referenced by'), h('th', {}, 'References'), h('th', {}, 'Last commit'), h('th', {}, 'Work'))),
      h('tbody', {}, detail.files.map((f) => h('tr', { dataset: { path: f.path } },
        h('td', {}, h('button', { class: 'kv-text-btn kv-mono', type: 'button', onClick: () => ctx.openFile(t.repo ?? repo, f.path) }, f.path),
          f.generated ? h('span', { class: 'kv-tag kv-purple', title: 'Generated code' }, 'generated') : null),
        h('td', { class: 'kv-muted' }, num(f.lines)),
        h('td', {}, refList(f.importedBy)),
        h('td', {}, refList(f.imports)),
        h('td', { class: 'kv-muted' }, f.lastCommit ? h('span', { title: f.lastCommit.subject }, `${day(f.lastCommit.occurred)} · ${short(f.lastCommit.commit)}`) : '—'),
        h('td', {}, f.workId
          ? h('button', { class: 'kv-tag', type: 'button', onClick: () => ctx.openWork(f.workId) }, f.workLabel ?? workLabels.get(f.workId) ?? f.workId)
          : h('span', { class: 'kv-none' }, '—')))))));
  };
  ctx.fetchTerritory(t.id).then(draw, (e) => { td.replaceChildren(h('div', { class: 'kv-none' }, `Could not load: ${e.message}`)); });
  return tr;
}

export function renderCodeView(container, codeView, ctx) {
  ensureStyle();
  container.replaceChildren();
  const byId = new Map(codeView.territories.map((t) => [t.id, t]));
  const workLabels = new Map();
  for (const t of codeView.territories) for (const b of t.builtBy) if (b.workId) workLabels.set(b.workId, b.label);
  const drillOpen = new Set();

  const groups = [];
  for (const t of codeView.territories) {
    const key = t.row.kind === 'area' ? t.row.areaId : t.row.kind;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.territories.push(t);
    else groups.push({ key, row: t.row, territories: [t] });
  }

  const terrCells = (t) => {
    const deps = terrNames(t.dependsOn, byId, t.dependsOnCounts);
    const depsBy = terrNames(t.dependedBy, byId, t.dependedByCounts);
    const built = t.builtBy.map((b) => b.workId
      ? h('button', { class: 'kv-tag', type: 'button', title: `${b.label} · merge ${b.commits.map(short).join(', ')}`, onClick: () => ctx.openWork(b.workId) }, `${b.label.split(' ')[0]} ×${b.files}`)
      : h('span', { class: 'kv-tag', title: `${b.label} · ${b.commits.map(short).join(', ')}` }, `— ×${b.files}`));
    const drill = () => {
      const name = `${t.name} · ${t.paths.join(' ')}`;
      const row = container.querySelector(`tr.kv-drill[data-tid="${t.id}"]`);
      if (row) { row.remove(); drillOpen.delete(t.id); return; }
      drillOpen.add(t.id);
      const anchor = container.querySelector(`tr[data-terr="${t.id}"]`);
      anchor?.after(drillRow(t, codeView.version.repo, ctx, workLabels));
    };
    return [
      h('td', { class: 'kv-col-terr' },
        h('div', { class: 'kv-tblock' },
          h('div', {},
            h('button', { class: 'kv-text-btn kv-tname', type: 'button', title: 'Drill down to files', onClick: drill }, t.name),
            t.paths.map((p) => h('span', { class: 'kv-path kv-mono' }, ` ${p} `)),
            h('span', { class: 'kv-size' }, `· ${num(t.size.files)} files · ${num(t.size.lines)} lines`)),
          h('div', { class: 'kv-muted' }, t.summary),
          // A path the current version no longer has (CKC-25 AC-10): the numbers count only what is left.
          t.gonePaths?.length ? h('div', { class: 'kv-gone', title: 'Deleted or moved since the territory was drawn; the next round’s cross-check draws it again on the current paths' },
            `⚠ ${t.gonePaths.length === t.paths.length ? 'Its code is gone from the current version' : 'Not in the current version'}: `, t.gonePaths.map((p) => h('span', { class: 'kv-mono' }, `${p} `))) : null,
          t.size.generatedLines
            ? h('div', { class: 'kv-generated' }, `generated: ${num(t.size.generatedFiles)} file · ${num(t.size.generatedLines)} lines; handwritten ≈ ${num(t.size.lines - t.size.generatedLines)} lines`)
            : null,
          deps || depsBy ? h('div', { class: 'kv-deps kv-muted' },
            deps ? h('div', {}, `depends on: ${deps}`) : null,
            depsBy ? h('div', {}, `depended by: ${depsBy}`) : null) : null,
          t.alsoServes.length ? h('div', { class: 'kv-deps' }, alsoServesChip(t.alsoServes)) : null)),
      h('td', { class: 'kv-col-built' },
        h('div', {}, built),
        t.generations.length ? h('div', { class: 'kv-gens kv-muted' }, 'made in: ', t.generations.slice(0, 2).map((g, i) => h('span', {}, i ? ' · ' : null, `${g.name} ${Math.round(g.share * 100)}%`, g.works?.length ? [' ', genWorksChip(g)] : null))) : null,
        t.tests ? h('div', { style: 'margin-top:3px' }, h('span', { class: 'kv-tag kv-green' }, `tests ${t.tests}`)) : null,
        t.lastChange ? h('div', { class: 'kv-faint', style: 'margin-top:3px' }, `last change ${day(t.lastChange.occurred)} · `, h('span', { class: 'kv-mono', title: t.lastChange.subject }, short(t.lastChange.commit))) : null),
      h('td', { class: 'kv-col-use' },
        // `Not known` (§1.16): no code, or code nothing reaches whose references the ledger reads none of — stated as it
        // stands, neither in use nor residual, so no ⚠ and no lit tone. `In use, not in current plan`: current code
        // references it and nothing current in the plan points at it — in use, so not lit, and said apart from `In current plan`.
        t.currentUse === 'Not known'
          ? h('span', { class: 'kv-use kv-unknown', title: 'The ledger reads the references of none of this territory’s code, or it holds none: nothing is claimed about its use either way' }, t.currentUse)
          : t.currentUse === 'In use, not in current plan'
            ? h('span', { class: 'kv-use kv-unplanned', title: 'Current code references it, and no current work item changed it and no current requirement, design, decision, plan or work points at its area' }, t.currentUse)
            : h('span', {
              class: `kv-use ${t.currentUse === 'Unreferenced' ? 'kv-lit-red' : t.currentUse === 'Previous generation only' ? 'kv-lit' : ''}`,
              title: t.currentUse === 'In current plan' ? 'Current code references it, and current work or requirements point at it' : '',
            }, t.currentUse === 'In current plan' ? t.currentUse : `⚠ ${t.currentUse}`)),
      h('td', { class: 'kv-col-state' },
        t.anomalies.length ? t.anomalies.map((a) => anomalyView(a, ctx)) : h('span', { class: 'kv-none' }, '—')),
    ];
  };

  const body = [];
  for (const g of groups) {
    const label = g.row.kind === 'area' ? g.row.areaName : g.row.kind === 'shared' ? 'Shared base' : 'Not product code';
    g.territories.forEach((t, i) => {
      body.push(h('tr', { dataset: { terr: t.id, rowKind: g.row.kind } },
        i === 0 ? h('td', { class: 'kv-area-cell', rowspan: String(g.territories.length) },
          h('div', { class: g.row.kind === 'area' ? 'kv-area-name' : 'kv-muted' }, label),
          // The area's one line as Product intent writes it (TerritoryView.row.areaLine), when the view carries it.
          g.row.kind === 'area' && g.row.areaLine ? h('div', { class: 'kv-muted kv-arealine' }, g.row.areaLine) : null) : null,
        terrCells(t)));
    });
  }

  container.append(h('div', { class: 'kv-code', dataset: { kv: 'code' } },
    h('div', { class: 'kv-head' },
      h('h2', {}, 'Code'),
      h('div', { class: 'kv-chips' },
        h('span', { class: 'kv-chip' }, 'Current version: ', h('b', {}, codeView.version.repo), codeView.version.branch ? ` · ${codeView.version.branch}` : '', ' · ', h('span', { class: 'kv-mono' }, short(codeView.version.commit)), ` · ${day(codeView.version.occurred)}`),
        h('span', { class: 'kv-chip kv-levels' }, 'Ledger code structure: ', codeView.levels.length
          ? codeView.levels.map((l, i) => [i ? ' · ' : null, h('span', { class: 'kv-level', dataset: { lang: l.language, readBy: l.readBy ?? 'none' }, title: l.gaps.length ? l.gaps.join('\n') : null },
            h('b', {}, l.language), ` — ${levelText(l)}`)])
          : 'no code in the current version'),
        h('span', { class: 'kv-chip' }, 'Generated: ', h('b', {}, fmtTime(codeView.generatedAt))))),
    h('table', { class: 'kv-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Product area'),
        h('th', {}, 'Code territories (current version)'),
        h('th', {}, 'Built by · verified'),
        h('th', {}, 'Used by current plan'),
        h('th', {}, 'State & anomalies'))),
      h('tbody', {}, body))));
  return container;
}
