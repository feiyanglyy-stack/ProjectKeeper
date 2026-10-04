/**
 * The key order on `Keeper` → `Model provider` (Spec §6.10 备用与并行; CKC-03 AC-35): "When a key runs out of quota or is
 * rate-limited". Its first row is the main key — the same setting as `Main model — key` — and every row, the first too,
 * chooses its key and its model, and can be moved or taken out; whichever row is first is the main key. Pure functions, so
 * the order the page sends is tested without a browser.
 */

/** The rows of the order: the main model first, then the backups. */
export function orderRows(route) {
  const thinking = route.main?.thinking ?? null;
  return [...(route.main ? [{ provider: route.main.provider, id: route.main.id, thinking, keyName: route.main.keyName, usable: route.main.usable }] : []), ...route.backups];
}

/**
 * What the page posts for an order (`POST /api/projects/:id/route`): the first row is the main model, the rest the
 * backups. The main model's thinking stays with the first place; a key moved down keeps the thinking it had as a backup,
 * or the main one's. `null` for an empty order: one key at least stays.
 */
export function orderBody(next, thinking) {
  if (!next.length) return null;
  const [main, ...backups] = next;
  return { model: { provider: main.provider, id: main.id, thinking }, backups: backups.map((b) => ({ provider: b.provider, id: b.id, thinking: b.thinking ?? thinking })) };
}

/** The row at `i` moved by `d` (−1 earlier, +1 later). */
export function moveRow(list, i, d) {
  const next = [...list];
  const [x] = next.splice(i, 1);
  next.splice(i + d, 0, x);
  return next;
}

/** The model a key runs in a row: the one asked for when the key carries it, else the main model, else its first. */
export function modelFor(key, prefer, mainId) {
  const has = (id) => Boolean(id) && key.models.some((m) => m.id === id);
  return has(prefer) ? prefer : has(mainId) ? mainId : key.models[0]?.id;
}

/**
 * Another key chosen for the row at `i` — every row chooses its key, the first too (one key per row). A key that sits in
 * another row changes places with this one, each keeping its model; chosen for a lower row from the first, or for the
 * first from a lower row, that is a change of the main key. A key outside the order takes the row, on the row's model
 * when it carries it, else the main model, else its first; the key that was there leaves the order.
 */
export function chooseKey(list, i, key, mainId) {
  const j = list.findIndex((x) => x.provider === key.id);
  if (j === i || !list[i]) return list;
  const next = [...list];
  if (j >= 0) [next[i], next[j]] = [next[j], next[i]];
  else next[i] = { provider: key.id, id: modelFor(key, list[i].id, mainId), thinking: list[i].thinking ?? null };
  return next;
}

/**
 * The main row's `Use` with a key that sits in a lower row of the order (DA): the two rows change places, as the list's
 * own select does, and the first row runs the model chosen — the old main key stays in the order, where it was dropped
 * before. `null` when the key is the main key already or is outside the order: the main model is then set as before.
 */
export function mainChosen(list, key, model, mainId) {
  if (!key || list.findIndex((x) => x.provider === key.id) <= 0) return null;
  return chooseKey(list, 0, key, mainId).map((x, i) => (i === 0 ? { ...x, id: model } : x));
}
