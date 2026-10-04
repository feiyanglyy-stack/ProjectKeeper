/**
 * Toolchain discovery (Spec §3.1, §6.7; CKC-03 AC-23). The Keeper may read the toolchain the
 * project's own configuration points at — an SDK, a compiler — to make sense of the build
 * environment. Those locations are found by the program from the project's own config, using
 * generic conventions, and become both an allowed read root (src/keeper/bounds) and a Project
 * scope entry the owner can see and correct (§6.7).
 *
 * Only absolute paths a config file *states*, that exist on disk and lie *outside* the project's
 * own locations, are returned; each carries the config file and the item it came from as its
 * reason. Version-manager files that name a tool and version but not a path (a version pin, an
 * install manifest) are intentionally not resolved to guessed install directories — nothing is
 * added on speculation.
 *
 * A declared location that is too broad — a filesystem root, the home directory or anything
 * containing it, the ProjectKeeper home or anything containing it or inside it, a directory that
 * contains the project — is still listed so the owner can see and correct it, but flagged
 * `used: false` with the reason, and never becomes a read root.
 */
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isWithin, normalizePath, pathKey } from '../util/paths.ts';
import { projectKeeperHome as defaultProjectKeeperHome } from '../store/paths.ts';
import { broadRootReason } from '../keeper/bounds/paths.ts';

export interface ToolchainRoot {
  /** Normalised absolute directory the config names. */
  readonly path: string;
  /** Which config file, and which item in it, points here (§6.7: reason shown to the owner). */
  readonly reason: string;
  /** The config file the location was declared in. */
  readonly configPath: string;
  /** Whether it is an allowed read root; false when it is too broad (see notUsedReason). */
  readonly used: boolean;
  /** Why it is not used, e.g. "not used: too broad (the whole home directory)"; null when used. */
  readonly notUsedReason: string | null;
}

/** The directories a toolchain location is compared against (passed in, so tests never use the real ones). */
export interface ToolchainOptions {
  /** The user's home directory. Default: the real one. */
  readonly home?: string;
  /** The ProjectKeeper home in use. Default: the configured one. */
  readonly projectKeeperHome?: string;
}

/** A property/Gradle-style value: unescape the Java `\:` and `\\` escapes and trim. */
function unescapeProperty(value: string): string {
  return value.replace(/\\(.)/g, '$1').trim();
}

/** A concrete absolute filesystem path, or null for macros ($VAR$, $PROJECT_DIR$), URLs and relatives. */
function concreteAbsolute(raw: string): string | null {
  let s = raw.trim().replace(/^["']|["']$/g, '');
  if (!s || s.includes('$')) return null;                     // IDE/Gradle macros are not concrete
  if (s.startsWith('file://')) s = s.replace(/^file:\/\//, '');
  else if (s.startsWith('jar://')) s = s.replace(/^jar:\/\//, '').replace(/!.*$/, '');
  // A leading slash before a Windows drive from a file:// URL: /C:/x → C:/x
  if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
  if (!isAbsolute(s) && !/^[A-Za-z]:[\\/]/.test(s)) return null;
  return normalizePath(s);
}

/** The directory a candidate names: the directory itself, or the parent of a file (a compiler binary). */
function candidateDir(path: string): string | null {
  try {
    const st = statSync(path);
    return st.isDirectory() ? path : normalizePath(dirname(path));
  } catch {
    return null;
  }
}

interface RawHit { readonly value: string; readonly where: string }

/** `key = value` lines whose key names a tool location (…dir/home/path/sdk/root). */
function fromProperties(text: string): RawHit[] {
  const out: RawHit[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w.\-]*(?:dir|home|path|sdk|root))\s*[:=]\s*(.+?)\s*$/i.exec(line);
    if (m && !line.trimStart().startsWith('#') && !line.trimStart().startsWith('!')) out.push({ value: unescapeProperty(m[2]!), where: m[1]! });
  }
  return out;
}

/** JetBrains library / module roots: url="file://…" or url="jar://…!/…". */
function fromIdeaXml(text: string): RawHit[] {
  const out: RawHit[] = [];
  for (const m of text.matchAll(/url\s*=\s*"((?:file|jar):\/\/[^"]+)"/g)) out.push({ value: m[1]!, where: 'library root' });
  return out;
}

/** CMake cache PATH/FILEPATH entries. */
function fromCMakeCache(text: string): RawHit[] {
  const out: RawHit[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^#/][^:=]*):(PATH|FILEPATH)=(.+)$/.exec(line);
    if (m) out.push({ value: m[3]!, where: `${m[1]!} (${m[2]!})` });
  }
  return out;
}

/** Read a config file if it is present and not too large. */
function readIfPresent(file: string, maxBytes = 2_000_000): string | null {
  try {
    if (!existsSync(file) || statSync(file).size > maxBytes) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function ideaLibraryFiles(location: string): string[] {
  const dir = join(location, '.idea', 'libraries');
  try {
    return readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.xml')).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function topLevelFilesBySuffix(location: string, suffix: string): string[] {
  try {
    return readdirSync(location).filter((n) => n.toLowerCase().endsWith(suffix)).map((n) => join(location, n));
  } catch {
    return [];
  }
}

/**
 * Toolchain roots declared by the project's own configuration. `locations` are the project's own
 * directories (a path inside one of them is already in scope, so it is never reported as toolchain).
 */
export function discoverToolchain(locations: readonly string[], options: ToolchainOptions = {}): ToolchainRoot[] {
  const roots = locations.map((l) => normalizePath(l));
  const breadth = { home: options.home ?? homedir(), projectKeeperHome: options.projectKeeperHome ?? defaultProjectKeeperHome(), projectLocations: roots };
  const out: ToolchainRoot[] = [];
  const seen = new Set<string>();
  const add = (rawValue: string, configPath: string, where: string) => {
    const abs = concreteAbsolute(rawValue);
    if (!abs) return;
    const dir = candidateDir(abs);
    if (!dir) return;                                          // must exist on disk
    if (roots.some((r) => isWithin(r, dir))) return;           // already inside the project
    const key = pathKey(dir);
    if (seen.has(key)) return;
    seen.add(key);
    const notUsedReason = broadRootReason(dir, breadth);
    out.push({ path: dir, reason: `${basename(configPath)} declares ${where} → ${dir}`, configPath, used: notUsedReason === null, notUsedReason });
  };

  for (const location of roots) {
    if (!existsSync(location)) continue;
    const props = readIfPresent(join(location, 'local.properties'));
    if (props) for (const h of fromProperties(props)) add(h.value, join(location, 'local.properties'), h.where);
    const cmake = readIfPresent(join(location, 'CMakeCache.txt'));
    if (cmake) for (const h of fromCMakeCache(cmake)) add(h.value, join(location, 'CMakeCache.txt'), h.where);
    for (const xml of [...ideaLibraryFiles(location), ...topLevelFilesBySuffix(location, '.iml')]) {
      const text = readIfPresent(xml);
      if (text) for (const h of fromIdeaXml(text)) add(h.value, xml, h.where);
    }
  }
  return out;
}

/** A toolchain entry as stored on the project (records written before the used flag existed lack it). */
export interface StoredToolchainEntry {
  readonly path: string;
  readonly used?: boolean;
  readonly notUsedReason?: string | null;
}

/**
 * The toolchain entries the read boundary considers: the ones stored on the project, or discovered now when scope
 * discovery has not stored any. The boundary re-checks each for breadth itself; the stored flag is for display.
 */
export function toolchainRoots(project: { readonly toolchain?: readonly StoredToolchainEntry[]; readonly locations: readonly string[] }, options: ToolchainOptions = {}): readonly StoredToolchainEntry[] {
  return project.toolchain ? [...project.toolchain] : discoverToolchain(project.locations, options);
}
