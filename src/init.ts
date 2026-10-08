import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { NATIVE_HIGHLIGHT_FIELDS, NATIVE_ID_FIELDS, NATIVE_LABEL_FIELDS } from './config';

export const PLUGIN_NAME = '@vibeview/roku-bsc-plugin';

/** The slice of jsonc-parser (2.x) that init uses. */
interface Jsonc {
  parse(text: string, errors?: unknown[], options?: { allowTrailingComma?: boolean }): unknown;
  modify(
    text: string,
    path: (string | number)[],
    value: unknown,
    options: { formattingOptions: { insertSpaces: boolean; tabSize: number; eol?: string } },
  ): unknown[];
  applyEdits(text: string, edits: unknown[]): string;
}

export const BSC_NOT_FOUND =
  'roku-bsc-plugin init: brighterscript not found \u2014 run init from your channel project after installing brighterscript';

/**
 * bsconfig.json is JSONC. brighterscript itself reads it with jsonc-parser, so load it from the
 * project's brighterscript (brighterscript is a peer dependency) rather than declaring a second
 * copy. Resolved from the project first so a globally run or vendored plugin still finds it.
 */
function loadJsonc(): Jsonc | undefined {
  try {
    const bsc = require.resolve('brighterscript', { paths: [process.cwd(), __dirname] });
    return createRequire(bsc)('jsonc-parser') as Jsonc;
  } catch {
    return undefined;
  }
}

/** True for a plugins entry that is this plugin: its package name, alone or as whole path
 *  segments (`node_modules/@vibeview/roku-bsc-plugin`), or a path to its build. */
function isThisPlugin(entry: unknown): boolean {
  if (typeof entry !== 'string') return false;
  const norm = entry.replace(/\\/g, '/');
  return (
    `/${norm}/`.includes(`/${PLUGIN_NAME}/`) || /(^|\/)roku-bsc-plugin\/dist\/index\.js$/.test(norm)
  );
}

export interface InitResult {
  ok: boolean;
  /** Lines for stdout (success) or stderr (refusal). */
  messages: string[];
}

export function vibeviewBlock() {
  return {
    enabled: false,
    highlightFields: [...NATIVE_HIGHLIGHT_FIELDS],
    idFields: [...NATIVE_ID_FIELDS],
    labelFields: [...NATIVE_LABEL_FIELDS],
  };
}

const NOTES = [
  'Comments are kept as they were; the block itself is written without comments. What it says:',
  '  enabled: false     markers are off for store builds; set true, or run with VIBEVIEW_MARKERS=1.',
  "  highlightFields    itemHasFocus: Roku sets it on a list's focused item (MarkupGrid, MarkupList,",
  '                     RowList, ZoomRowList). Add your own custom focus field here if the app has one.',
  "  idFields           itemContent.id: the item content node's native id.",
  "  labelFields        itemContent.title: the item content node's native title.",
  'A list you write is used exactly as written, so keep the native entry in it unless you mean to drop it.',
  'Skip a component entirely with "components": { "Name": false }.',
];

/** What the files a bsconfig `extends` (directly or through a chain) say. */
interface Inherited {
  /** The nearest base's `plugins`, entries starting with "." made absolute (as bsc does). */
  plugins?: { list: unknown[]; from: string };
  /** The nearest base's `vibeview` block. */
  vibeview?: { from: string };
}

/**
 * Follow `extends` the way bsc does (relative to the extending file, a leading "?" marking
 * an optional base). bsc merges a base shallowly under its child, so the nearest file that
 * sets a key wins it whole.
 */
function readBases(jsonc: Jsonc, file: string, extendsValue: unknown): Inherited | string {
  const inherited: Inherited = {};
  const seen = [file];
  let from = file;
  let next = extendsValue;
  while (typeof next === 'string') {
    const optional = next.startsWith('?');
    const base = path.resolve(path.dirname(from), optional ? next.slice(1) : next);
    if (seen.includes(base)) return `${file}: "extends" goes round in a circle (${base}).`;
    seen.push(base);
    if (!fs.existsSync(base)) {
      if (optional) break;
      return `${from} extends ${base}, which does not exist; nothing changed.`;
    }
    const errors: unknown[] = [];
    const doc = jsonc.parse(fs.readFileSync(base, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length > 0 || !doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return `${base} (extended by ${from}) is not a valid bsconfig; nothing changed.`;
    }
    const config = doc as Record<string, unknown>;
    if (inherited.plugins === undefined && Array.isArray(config.plugins)) {
      const dir = path.dirname(base);
      inherited.plugins = {
        list: config.plugins.map((p) =>
          typeof p === 'string' && p.startsWith('.') ? path.resolve(dir, p) : p,
        ),
        from: base,
      };
    }
    if (inherited.vibeview === undefined && config.vibeview !== undefined) {
      inherited.vibeview = { from: base };
    }
    from = base;
    next = config.extends;
  }
  return inherited;
}

/** An absolute plugin path as written in a bsconfig in `dir` (bsc reads "./x" from there). */
function relativeTo(dir: string, entry: unknown): unknown {
  if (typeof entry !== 'string' || !path.isAbsolute(entry)) return entry;
  const rel = path.relative(dir, entry).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Add the plugin and a `vibeview` block to <dir>/bsconfig.json, keeping what is there. */
export function runInit(dir: string, opts: { force?: boolean } = {}): InitResult {
  const file = path.join(dir, 'bsconfig.json');
  const existed = fs.existsSync(file);
  const text = existed ? fs.readFileSync(file, 'utf8') : '{}\n';
  const jsonc = loadJsonc();
  if (!jsonc) return { ok: false, messages: [BSC_NOT_FOUND] };

  const errors: unknown[] = [];
  const doc = jsonc.parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, messages: [`${file} is not a valid bsconfig.json; fix it and run again.`] };
  }
  const root = doc as Record<string, unknown>;
  const inherited = readBases(jsonc, file, root.extends);
  if (typeof inherited === 'string') return { ok: false, messages: [inherited] };
  if (root.vibeview !== undefined && !opts.force) {
    return {
      ok: false,
      messages: [
        `${file} already has a "vibeview" block; nothing changed.`,
        'Run again with --force to replace it with the defaults.',
      ],
    };
  }
  if (root.plugins !== undefined && !Array.isArray(root.plugins)) {
    return { ok: false, messages: [`"plugins" in ${file} is not an array; nothing changed.`] };
  }

  const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  let next = text;
  const done: string[] = [];
  if (Array.isArray(root.plugins)) {
    if (root.plugins.some(isThisPlugin)) done.push('plugin already listed');
    else {
      next = jsonc.applyEdits(next, jsonc.modify(next, ['plugins', -1], PLUGIN_NAME, fmt));
      done.push(`added "${PLUGIN_NAME}" to plugins`);
    }
  } else if (inherited.plugins?.list.some(isThisPlugin)) {
    done.push(`plugin already listed in ${inherited.plugins.from}`);
  } else {
    // A `plugins` written here replaces the base's whole list, so carry the base's over.
    const list = [...(inherited.plugins?.list ?? []).map((p) => relativeTo(dir, p)), PLUGIN_NAME];
    next = jsonc.applyEdits(next, jsonc.modify(next, ['plugins'], list, fmt));
    done.push(
      inherited.plugins
        ? `wrote plugins: the list from ${inherited.plugins.from} plus "${PLUGIN_NAME}"`
        : `added "${PLUGIN_NAME}" to plugins`,
    );
  }
  if (inherited.vibeview && root.vibeview === undefined && !opts.force) {
    // Writing one here would replace the base's block whole.
    done.push(`kept the "vibeview" block in ${inherited.vibeview.from} (--force writes one here)`);
  } else {
    next = jsonc.applyEdits(next, jsonc.modify(next, ['vibeview'], vibeviewBlock(), fmt));
    done.push('wrote the "vibeview" block');
  }
  fs.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`);

  return {
    ok: true,
    messages: [`${existed ? 'Updated' : 'Created'} ${file}: ${done.join(', ')}.`, ...NOTES],
  };
}
