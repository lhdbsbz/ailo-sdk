/**
 * Build role snapshot + refs from Playwright aria_snapshot output.
 * Port of CoPaw's browser_snapshot.py to TypeScript.
 */

export interface RefInfo {
  role: string;
  name?: string;
  nth?: number;
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "searchbox", "slider", "spinbutton", "switch", "tab", "treeitem",
]);

const CONTENT_ROLES = new Set([
  "heading", "cell", "gridcell", "columnheader", "rowheader",
  "listitem", "article", "region", "main", "navigation",
]);

const STRUCTURAL_ROLES = new Set([
  "generic", "group", "list", "table", "row", "rowgroup", "grid",
  "treegrid", "menu", "menubar", "toolbar", "tablist", "tree",
  "directory", "document", "application", "presentation", "none",
]);

function getIndentLevel(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? Math.floor(m[1].length / 2) : 0;
}

interface Tracker {
  getNextIndex(role: string, name: string | undefined): number;
  trackRef(role: string, name: string | undefined, ref: string): void;
  getDuplicateKeys(): Set<string>;
  getKey(role: string, name: string | undefined): string;
}

function createTracker(): Tracker {
  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();

  function getKey(role: string, name: string | undefined): string {
    return `${role}:${name ?? ""}`;
  }

  return {
    getKey,
    getNextIndex(role, name) {
      const key = getKey(role, name);
      const current = counts.get(key) ?? 0;
      counts.set(key, current + 1);
      return current;
    },
    trackRef(role, name, ref) {
      const key = getKey(role, name);
      const list = refsByKey.get(key) ?? [];
      list.push(ref);
      refsByKey.set(key, list);
    },
    getDuplicateKeys() {
      const dups = new Set<string>();
      for (const [k, refs] of refsByKey) {
        if (refs.length > 1) dups.add(k);
      }
      return dups;
    },
  };
}

function removeNthFromNonDuplicates(refs: Map<string, RefInfo>, tracker: Tracker): void {
  const dupKeys = tracker.getDuplicateKeys();
  for (const [, data] of refs) {
    const key = tracker.getKey(data.role, data.name);
    if (!dupKeys.has(key) && data.nth !== undefined) {
      delete data.nth;
    }
  }
}

function compactTree(tree: string): string {
  const lines = tree.split("\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("[ref=")) { result.push(line); continue; }
    if (line.includes(":") && !line.trimEnd().endsWith(":")) { result.push(line); continue; }
    const currentIndent = getIndentLevel(line);
    let hasRelevant = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (getIndentLevel(lines[j]) <= currentIndent) break;
      if (lines[j].includes("[ref=")) { hasRelevant = true; break; }
    }
    if (hasRelevant) result.push(line);
  }
  return result.join("\n");
}

const LINE_RE = /^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/;

interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
}

function processLine(
  line: string,
  refs: Map<string, RefInfo>,
  options: SnapshotOptions,
  tracker: Tracker,
  nextRef: () => string,
): string | null {
  const depth = getIndentLevel(line);
  if (options.maxDepth !== undefined && depth > options.maxDepth) return null;

  const m = line.match(LINE_RE);
  if (!m) return options.interactive ? null : line;

  const [, prefix, roleRaw, name, suffix] = m;
  if (roleRaw.startsWith("/")) return options.interactive ? null : line;

  const role = roleRaw.toLowerCase();
  const isInteractive = INTERACTIVE_ROLES.has(role);
  const isContent = CONTENT_ROLES.has(role);

  if (options.interactive && !isInteractive) return null;
  if (options.compact && STRUCTURAL_ROLES.has(role) && !name) return null;

  const shouldHaveRef = isInteractive || (isContent && !!name);
  if (!shouldHaveRef) return line;

  const ref = nextRef();
  const nth = tracker.getNextIndex(role, name);
  tracker.trackRef(role, name, ref);
  refs.set(ref, { role, name: name || undefined, nth });

  let enhanced = `${prefix}${roleRaw}`;
  if (name) enhanced += ` "${name}"`;
  enhanced += ` [ref=${ref}]`;
  if (nth > 0) enhanced += ` [nth=${nth}]`;
  if (suffix) enhanced += suffix;
  return enhanced;
}

export function buildRoleSnapshotFromAria(
  ariaSnapshot: string,
  options: SnapshotOptions = {},
): { snapshot: string; refs: Map<string, RefInfo> } {
  const lines = ariaSnapshot.split("\n");
  const refs = new Map<string, RefInfo>();
  const tracker = createTracker();
  let counter = 0;
  const nextRef = () => `e${++counter}`;

  if (options.interactive) {
    const resultLines: string[] = [];
    for (const line of lines) {
      const depth = getIndentLevel(line);
      if (options.maxDepth !== undefined && depth > options.maxDepth) continue;
      const m = line.match(LINE_RE);
      if (!m) continue;
      const [, , roleRaw, name, suffix] = m;
      if (roleRaw.startsWith("/")) continue;
      const role = roleRaw.toLowerCase();
      if (!INTERACTIVE_ROLES.has(role)) continue;

      const ref = nextRef();
      const nth = tracker.getNextIndex(role, name);
      tracker.trackRef(role, name, ref);
      refs.set(ref, { role, name: name || undefined, nth });

      let enhanced = `- ${roleRaw}`;
      if (name) enhanced += ` "${name}"`;
      enhanced += ` [ref=${ref}]`;
      if (nth > 0) enhanced += ` [nth=${nth}]`;
      if (suffix?.includes("[")) enhanced += suffix;
      resultLines.push(enhanced);
    }
    removeNthFromNonDuplicates(refs, tracker);
    return { snapshot: resultLines.join("\n") || "(no interactive elements)", refs };
  }

  const resultLines: string[] = [];
  for (const line of lines) {
    const processed = processLine(line, refs, options, tracker, nextRef);
    if (processed !== null) resultLines.push(processed);
  }
  removeNthFromNonDuplicates(refs, tracker);
  const tree = resultLines.join("\n") || "(empty)";
  const snapshot = options.compact ? compactTree(tree) : tree;
  return { snapshot, refs };
}
