// What intake could not take in (CKC-07 AC-10), as the top bar counts it and its list shows it (owner 2026-09-30: "2
// failed" could not be opened, and it was one file recorded twice). No DOM here: tested with `node --test`
// (src/ui/failures.test.ts). The server keeps one entry per ref too (src/intake/intake.ts `latestFailures`); this also
// folds what an older home still holds, and the entries of several scopes.
//
// A file over the size intake reads of one file is not a failure (D105; owner: 「超过 2 MB 的上限 这个不要红色的」): it is
// `Skipped: too large`, listed in Project scope with its size and the limit, and the top bar neither counts it nor
// shows it in the colour of an error. The server records it apart (`scope.skipped`, src/intake/skipped.ts); a home
// written before that still holds it among its failures, and it is read as skipped here all the same.

const TOO_LARGE = /^larger than (\d+) bytes$/;
const tooLargeLimit = (reason) => { const m = TOO_LARGE.exec(String(reason ?? '').trim()); return m ? Number(m[1]) : null; };

/**
 * One entry per ref across the coverage's scopes: the latest (by `at`; the later listed on a tie), each with the label of
 * the scope it was recorded under, newest first. Only what really failed: a file too large to read is skipped (`skippedOf`).
 */
export function failuresOf(coverage) {
  const byRef = new Map();
  for (const s of coverage?.scopes ?? []) {
    for (const f of s.failed ?? []) {
      const before = byRef.get(f.ref);
      if (before && String(before.at) > String(f.at)) continue;
      byRef.set(f.ref, { ...f, scope: s.label ?? s.id });
    }
  }
  return [...byRef.values()].filter((f) => tooLargeLimit(f.reason) === null).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * The files skipped as too large across the coverage's scopes, one entry per file (the latest), newest first: each with
 * its size when it was skipped (null when an older home did not record it) and the limit, in bytes.
 */
export function skippedOf(coverage) {
  const byRef = new Map();
  const take = (entry) => {
    const before = byRef.get(entry.ref);
    if (before && String(before.at) > String(entry.at)) return;
    byRef.set(entry.ref, entry);
  };
  for (const s of coverage?.scopes ?? []) {
    for (const k of s.skipped ?? []) take({ ref: k.ref, bytes: k.bytes ?? null, limit: k.limit, at: k.at, scope: s.label ?? s.id });
    for (const f of s.failed ?? []) {
      const limit = tooLargeLimit(f.reason);
      if (limit !== null) take({ ref: f.ref, bytes: null, limit, at: f.at, scope: s.label ?? s.id });
    }
  }
  return [...byRef.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** A size in words: `2.4 MB (2,400,000 bytes)`; MB as intake counts its limit, a million bytes. */
export function sizeText(bytes) {
  const n = Number(bytes);
  if (bytes === null || bytes === undefined || !Number.isFinite(n)) return 'size not recorded';
  const mb = n / 1_000_000;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB (${n.toLocaleString('en-US')} bytes)`;
}

/** One skipped file in words: its size and the limit. */
export function skippedText(entry) {
  return `${sizeText(entry.bytes)} · the most intake reads of one file is ${sizeText(entry.limit)}`;
}

/** The reason in words: a byte limit also in MB, the rest as recorded. */
export function reasonText(reason) {
  const m = /^larger than (\d+) bytes$/.exec(String(reason ?? '').trim());
  if (!m) return String(reason ?? '');
  const n = Number(m[1]);
  const mb = n / 1_000_000;
  return `larger than ${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB (${n.toLocaleString('en-US')} bytes), the most intake reads of one file`;
}

/** The path shown under a project location it lies in (with forward slashes), else as recorded. */
export function shortRef(ref, locations = []) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(ref);
  for (const loc of locations) {
    const l = norm(loc);
    if (l && r.toLowerCase().startsWith(`${l.toLowerCase()}/`)) return r.slice(l.length + 1);
  }
  return String(ref);
}
