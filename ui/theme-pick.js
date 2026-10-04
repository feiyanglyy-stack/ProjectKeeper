// Which theme opens, and which files that is (Spec §6.16; CKC-09 AC-40). Pure: the choice kept in this browser and
// the manifest go in, an id and two hrefs come out; theme.js does the DOM. Tested by src/ui/theme-pick.test.ts.

/** The factory look: ProjectKeeper's own dark skin, no theme file at all. Kept as the empty string, like WorkflowKeeper. */
export const FACTORY = '';
/** Where the choice is kept: this browser's, a personal preference, never a project asset. */
export const THEME_KEY = 'pk.theme';

const isFolder = (id) => /^[a-z0-9][a-z0-9_-]*$/i.test(String(id));

/**
 * The theme to open: what this browser remembers when the manifest still lists it (the factory look counts as
 * remembered); else the manifest's default; else the factory look. Without a manifest there is nothing to load.
 */
export function resolveTheme(saved, manifest) {
  const ids = new Set((manifest?.themes ?? []).map((t) => t.id));
  if (saved === FACTORY) return FACTORY;
  if (typeof saved === 'string' && ids.has(saved)) return saved;
  return manifest && ids.has(manifest.default) ? manifest.default : FACTORY;
}

/** The two files of a theme: the frozen board and ProjectKeeper's own layer for it. The factory look is no file. */
export function themeHrefs(id) {
  if (id === FACTORY || !isFolder(id)) return { board: '', pk: '' };
  return { board: `/themes/${id}/board.css`, pk: `/themes/${id}/pk.css` };
}

/** What the picker offers: the factory look first, then the manifest's themes in its order, by their names. */
export function themeOptions(manifest) {
  return [{ id: FACTORY, name: 'Factory' }, ...(manifest?.themes ?? []).map((t) => ({ id: t.id, name: t.name }))];
}

/** A theme's name for a message; an unknown id is shown as itself. */
export function themeName(id, manifest) {
  return themeOptions(manifest).find((o) => o.id === id)?.name ?? String(id);
}
