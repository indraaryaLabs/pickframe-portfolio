export const RAW_EXTENSIONS = Object.freeze([
  '.3fr', '.ari', '.arw', '.bay', '.cap', '.cr2', '.cr3', '.crw', '.dcr', '.dcs',
  '.dng', '.drf', '.eip', '.erf', '.fff', '.gpr', '.iiq', '.k25', '.kdc', '.mdc',
  '.mef', '.mos', '.mrw', '.nef', '.nrw', '.obm', '.orf', '.pef', '.ptx', '.pxn',
  '.r3d', '.raf', '.raw', '.rwl', '.rw2', '.rwz', '.sr2', '.srf', '.srw', '.x3f',
]);
export const VISUAL_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.tif', '.tiff', '.png', '.heic']);
export const SIDECAR_EXTENSIONS = Object.freeze(['.xmp']);
export const SUPPORTED_EXTENSIONS = new Set([...RAW_EXTENSIONS, ...VISUAL_EXTENSIONS, ...SIDECAR_EXTENSIONS]);

function splitName(name = '') {
  const normalized = String(name).normalize('NFC');
  const index = normalized.lastIndexOf('.');
  return index > 0
    ? { stem: normalized.slice(0, index).toLocaleLowerCase('en-US'), extension: normalized.slice(index).toLocaleLowerCase('en-US') }
    : { stem: normalized.toLocaleLowerCase('en-US'), extension: '' };
}

function directoryOf(path = '') {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index < 0 ? '' : path.slice(0, index).toLocaleLowerCase('en-US');
}

function rawRank(extension) {
  if (extension === '.dng') return RAW_EXTENSIONS.length + 1;
  const index = RAW_EXTENSIONS.indexOf(extension);
  return index < 0 ? RAW_EXTENSIONS.length : index;
}

// Two same-stem files can only be told apart when the picker said which folder
// each came from. A picker that hands back bare filenames -- an iPadOS older
// than the release that learned to return a whole folder, or a photographer
// who picked files one by one -- leaves every entry looking like it sits in
// the same unnamed folder. Reading that as one folder is how the matcher used
// to pick one of two originals without saying so, so an entry without a path
// is given a group of its own and can no longer merge with anything.
function groupKey(entry) {
  return entry.pathKnown === false ? entry : directoryOf(entry.path);
}

function separateGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = groupKey(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
}

function uniqueById(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = entry.id ?? `${entry.path}\0${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function choosePrimary(raws) {
  if (separateGroups(raws).size > 1) return { ambiguous: raws };
  return { selected: [...raws].sort((a, b) => rawRank(a.extension) - rawRank(b.extension) || a.name.localeCompare(b.name))[0] };
}

export function indexEntries(entries = []) {
  const byStem = new Map();
  for (const original of entries) {
    if (!original || typeof original.name !== 'string') continue;
    const { stem, extension } = splitName(original.name);
    if (!stem || !SUPPORTED_EXTENSIONS.has(extension)) continue;
    const entry = { ...original, stem, extension, path: original.path || original.name, pathKnown: original.pathKnown ?? true };
    const group = byStem.get(stem) ?? [];
    group.push(entry);
    byStem.set(stem, group);
  }
  return byStem;
}

export function matchSelections(filenames, entries, { mode = 'raw-xmp', includeSidecars = true } = {}) {
  const index = entries instanceof Map ? entries : indexEntries(entries);
  const requested = [];
  const seen = new Set();
  for (const filename of filenames ?? []) {
    const name = String(filename ?? '').trim();
    const { stem } = splitName(name);
    if (!stem || seen.has(stem)) continue;
    seen.add(stem);
    requested.push({ name, stem });
  }

  const items = requested.map(({ name, stem }) => {
    const candidates = index.get(stem) ?? [];
    const raws = candidates.filter((entry) => RAW_EXTENSIONS.includes(entry.extension));
    const visuals = candidates.filter((entry) => VISUAL_EXTENSIONS.includes(entry.extension));
    const sidecars = candidates.filter((entry) => SIDECAR_EXTENSIONS.includes(entry.extension));
    const ambiguous = (withCandidates) => ({ requested: name, stem, status: 'ambiguous', candidates: withCandidates, files: [] });

    let primary;
    if (raws.length) {
      const choice = choosePrimary(raws);
      if (choice.ambiguous) return ambiguous(choice.ambiguous);
      primary = choice.selected;
    } else if (mode === 'any' && visuals.length) {
      const choice = choosePrimary(visuals);
      if (choice.ambiguous) return ambiguous(choice.ambiguous);
      primary = choice.selected;
    }

    if (!primary) return { requested: name, stem, status: visuals.length ? 'raw-absent' : 'missing', candidates: visuals, files: [] };

    // A companion belongs to the primary's folder. When the picker never said
    // which folder that was, the selection itself is the only evidence, and it
    // settles the question for exactly one candidate. Two same-stem sidecars or
    // JPEGs with nothing to place them are reported rather than guessed.
    const sameDirectory = (entry) => directoryOf(entry.path) === directoryOf(primary.path);
    const companionsOf = (entries) => {
      if (primary.pathKnown !== false) return { entries: entries.filter(sameDirectory), ambiguous: false };
      return { entries, ambiguous: entries.length > 1 };
    };

    const companions = [];
    let unclear = null;
    if (mode === 'raw-jpg') {
      const visualsChoice = companionsOf(visuals);
      if (visualsChoice.ambiguous) unclear ??= visualsChoice.entries;
      else companions.push(...visualsChoice.entries);
    }
    if (includeSidecars) {
      const sidecarChoice = companionsOf(sidecars);
      if (sidecarChoice.ambiguous) unclear ??= sidecarChoice.entries;
      else companions.push(...sidecarChoice.entries);
    }
    if (unclear) return ambiguous(unclear);
    return { requested: name, stem, status: 'matched', candidates, files: uniqueById([primary, ...companions]) };
  });

  const files = uniqueById(items.flatMap((item) => item.files));
  const counts = items.reduce((total, item) => ({ ...total, [item.status]: total[item.status] + 1 }), {
    matched: 0, missing: 0, 'raw-absent': 0, ambiguous: 0,
  });
  return { items, files, counts: { requested: requested.length, ...counts, files: files.length } };
}
