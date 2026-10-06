import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { NATIVE_HIGHLIGHT_FIELDS, NATIVE_ID_FIELDS, NATIVE_LABEL_FIELDS } from './config';

export const PLUGIN_NAME = 'vibeview-bsc-plugin';

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
  'vibeview-bsc-plugin init: brighterscript not found \u2014 run init from your channel project after installing brighterscript';

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

/** True for a plugins entry that is this plugin: its package name, or a path to its build. */
function isThisPlugin(entry: unknown): boolean {
  if (typeof entry !== 'string') return false;
  const norm = entry.replace(/\\/g, '/');
  return (
    norm.split('/').includes(PLUGIN_NAME) || /(^|\/)roku-bsc-plugin\/dist\/index\.js$/.test(norm)
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
  const plugins = (root.plugins as unknown[] | undefined) ?? [];
  const listed = plugins.some(isThisPlugin);
  if (!listed) {
    next = jsonc.applyEdits(
      next,
      jsonc.modify(
        next,
        root.plugins === undefined ? ['plugins'] : ['plugins', -1],
        root.plugins === undefined ? [PLUGIN_NAME] : PLUGIN_NAME,
        fmt,
      ),
    );
  }
  next = jsonc.applyEdits(next, jsonc.modify(next, ['vibeview'], vibeviewBlock(), fmt));
  fs.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`);

  return {
    ok: true,
    messages: [
      `${existed ? 'Updated' : 'Created'} ${file}: ${listed ? 'plugin already listed' : `added "${PLUGIN_NAME}" to plugins`}, wrote the "vibeview" block.`,
      ...NOTES,
    ],
  };
}
