export interface VibeviewConfig {
  /** Inject markers. Off by default so store builds stay untouched. */
  enabled: boolean;
  /** Candidate boolean field names, tried in order per component (native default when unset). */
  highlightFields: string[];
  /** Per-component override: false skips it, a string names the field. */
  components: Record<string, string | false>;
  /** Paths read for a stable test id, tried in order (`field` or `nodeField.field`). */
  idFields: string[];
  /** Paths read for a readable label, tried in order. */
  labelFields: string[];
}

/**
 * Roku's own list-item interface (MarkupGrid, MarkupList, RowList, ZoomRowList): the list sets
 * `itemHasFocus` (Boolean) on the one item that is its focused item, and `itemContent` (a
 * ContentNode) as the item's data, whose native `id` and `title` fields name it. These are
 * are the lists' defaults when the app writes none. Container flags
 * (`gridHasFocus`, `listHasFocus`, `rowHasFocus`, `rowListHasFocus`) are true for every item
 * and `focusPercent` is a float, so neither is a highlight candidate.
 */
export const NATIVE_HIGHLIGHT_FIELDS: readonly string[] = ['itemHasFocus'];
export const NATIVE_ID_FIELDS: readonly string[] = ['itemContent.id'];
export const NATIVE_LABEL_FIELDS: readonly string[] = ['itemContent.title'];

/**
 * Native fallback: a list the app did not write (absent, not an array, or empty once
 * filtered) is the native list. A list the app wrote is used exactly as written.
 */
const orNative = (written: string[], natives: readonly string[]): string[] =>
  written.length > 0 ? written : [...natives];

/** Whether `list` holds `entry`, ignoring case. */
export const hasEntry = (list: readonly string[], entry: string): boolean =>
  list.some((f) => f.toLowerCase() === entry.toLowerCase());

export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): VibeviewConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fields = Array.isArray(r.highlightFields)
    ? r.highlightFields.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : [];
  const components: Record<string, string | false> = {};
  if (r.components && typeof r.components === 'object' && !Array.isArray(r.components)) {
    for (const [name, value] of Object.entries(r.components as Record<string, unknown>)) {
      if (value === false || (typeof value === 'string' && value.length > 0))
        components[name] = value;
    }
  }
  const paths = (v: unknown) =>
    Array.isArray(v)
      ? v.filter(
          (p): p is string =>
            typeof p === 'string' && p.length > 0 && p.split('.').length <= 2 && !p.includes('"'),
        )
      : [];
  return {
    enabled: r.enabled === true || env.VIBEVIEW_MARKERS === '1',
    highlightFields: orNative(fields, NATIVE_HIGHLIGHT_FIELDS),
    components,
    idFields: orNative(paths(r.idFields), NATIVE_ID_FIELDS),
    labelFields: orNative(paths(r.labelFields), NATIVE_LABEL_FIELDS),
  };
}
