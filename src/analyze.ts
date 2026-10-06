import { DiagnosticSeverity, isBrsFile, isXmlFile, ParseMode, util } from 'brighterscript';
import type { BscFile, Callable, Program, Range, SGNode, XmlFile, XmlScope } from 'brighterscript';
import {
  hasEntry,
  NATIVE_HIGHLIGHT_FIELDS,
  NATIVE_ID_FIELDS,
  NATIVE_LABEL_FIELDS,
  type VibeviewConfig,
} from './config';
import { HELPER_PKG_PATH } from './runtime';

export interface ComponentPlan {
  /** Component name, as declared. */
  name: string;
  /** Lower-cased pkgPath of the component's XML, e.g. components/foo.xml. */
  xmlPkgPath: string;
  /** Chosen boolean highlight field. */
  field?: string;
  /** [node id, test id] pairs from vibeviewId attributes. */
  ids: [string, string][];
  /** Lower-cased pkgPath of the .brs file whose init() this component resolves; undefined => no init anywhere. */
  initPkgPath?: string;
  /** Reason when skipped (inline script). */
  skipped?: string;
}

export interface Analysis {
  /** By lower-cased component name, marked components only. */
  plans: Map<string, ComponentPlan>;
  /** By lower-cased init .brs pkgPath; each table is keyed by component name as declared. */
  initTables: Map<string, Record<string, { field?: string; ids?: [string, string][] }>>;
  /** Lower-cased xml pkgPaths that get the helper <script> tag. */
  needsHelper: Set<string>;
  /** Lower-cased xml pkgPaths with vibeviewId attributes to strip. */
  stripIds: Set<string>;
}

export const DIAGNOSTIC_CODE = 'vibeview';

const ID_RE = /^[A-Za-z0-9_.-]+$/;
/** SceneGraph accepts both spellings for a boolean interface field. */
const BOOLEAN_TYPES = new Set(['boolean', 'bool']);
const CALLS_HELPER = /\bvibeview_set(Highlight|Id)\s*\(/i;
const INDEXES_TOP_CHILDREN = /m\.top\.getChild(Count)?\s*\(/i;
const lower = (s: string) => s.replace(/\\/g, '/').toLowerCase();
const isHelper = (file: BscFile) => lower(file.pkgPath) === lower(HELPER_PKG_PATH);

function report(
  file: BscFile,
  message: string,
  severity: DiagnosticSeverity,
  range: Range = util.createRange(0, 0, 0, 0),
) {
  file.addDiagnostics([
    { message: `vibeview: ${message}`, code: DIAGNOSTIC_CODE, range, file, severity },
  ]);
}

/**
 * The declared id of `field` on the component or its nearest ancestor that declares it,
 * and whether it is boolean (`boolean` or `bool`). SceneGraph field names and types are
 * case-insensitive.
 */
function findField(
  file: XmlFile | undefined,
  field: string,
): { id: string; boolean: boolean } | undefined {
  const wanted = field.toLowerCase();
  for (let f = file; f; f = f.parentComponent) {
    const declared = f.ast.component?.api?.fields.find((x) => x.id?.toLowerCase() === wanted);
    if (declared)
      return { id: declared.id, boolean: BOOLEAN_TYPES.has(declared.type?.toLowerCase() ?? '') };
  }
  return undefined;
}

function overrideFor(config: VibeviewConfig, name: string): string | false | undefined {
  if (name in config.components) return config.components[name];
  const key = Object.keys(config.components).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : config.components[key];
}

function chooseField(file: XmlFile, name: string, config: VibeviewConfig): string | undefined {
  const override = overrideFor(config, name);
  if (override === false) return undefined;
  if (typeof override === 'string') {
    const found = findField(file, override);
    if (found?.boolean) return found.id;
    report(
      file,
      `${name}: override field "${override}" is not a boolean field of the component; skipped`,
      DiagnosticSeverity.Warning,
      file.componentName?.range,
    );
    return undefined;
  }
  for (const candidate of config.highlightFields) {
    const found = findField(file, candidate);
    if (found?.boolean) return found.id;
    if (found) {
      report(
        file,
        `${name}: field "${candidate}" is not a boolean/bool field; trying the next candidate`,
        DiagnosticSeverity.Hint,
        file.componentName?.range,
      );
    }
  }
  return undefined;
}

function collectIds(file: XmlFile): [string, string][] {
  const ids: [string, string][] = [];
  const visit = (nodes: SGNode[] | undefined) => {
    for (const node of nodes ?? []) {
      const testId = node.getAttributeValue('vibeviewId');
      if (testId !== undefined) {
        const range = node.getAttribute('vibeviewid')?.range ?? node.range;
        const nodeId = node.getAttributeValue('id');
        if (!nodeId) {
          report(
            file,
            `vibeviewId="${testId}" needs an id attribute on the same element`,
            DiagnosticSeverity.Error,
            range,
          );
        } else if (!ID_RE.test(nodeId)) {
          report(
            file,
            `vibeviewId="${testId}" is on an element whose id "${nodeId}" is not usable (allowed: A-Z a-z 0-9 _ . -)`,
            DiagnosticSeverity.Error,
            range,
          );
        } else if (!ID_RE.test(testId)) {
          report(
            file,
            `vibeviewId "${testId}" is a bad id (allowed: A-Z a-z 0-9 _ . -)`,
            DiagnosticSeverity.Error,
            range,
          );
        } else {
          ids.push([nodeId, testId]);
        }
      }
      visit(node.children);
    }
  };
  visit(file.ast.component?.children?.children);
  return ids;
}

const hasInlineCode = (file: XmlFile) =>
  (file.ast.component?.scripts ?? []).some((s) => !s.uri && !!s.cdata?.text.trim());

/**
 * The init() the component runs as its own: the closest non-namespaced `init` in its scope.
 * bsc's Scope.getCallableByName lets an ancestor's callable overwrite the component's own
 * (it fills a map own-first, then parents), so walk getAllCallables (own first) instead.
 */
function resolveInit(scope: XmlScope | undefined): Callable | undefined {
  return scope
    ?.getAllCallables()
    .map((c) => c.callable)
    .find((c) => !c.hasNamespace && c.name.toLowerCase() === 'init' && isBrsFile(c.file));
}

/**
 * Once per build, on the first component file: the effective lists, and a warning for each
 * written list that leaves out Roku's native entry (a list the app writes is used as is).
 */
function reportEffectiveLists(file: XmlFile, config: VibeviewConfig) {
  const range = file.componentName?.range;
  const list = (l: string[]) => `[${l.join(', ')}]`;
  report(
    file,
    `highlight ${list(config.highlightFields)}, ids ${list(config.idFields)}, labels ${list(config.labelFields)}`,
    DiagnosticSeverity.Information,
    range,
  );
  const checks: [string, string[], readonly string[], string][] = [
    ['highlightFields', config.highlightFields, NATIVE_HIGHLIGHT_FIELDS, 'marked'],
    ['idFields', config.idFields, NATIVE_ID_FIELDS, 'given an id'],
    ['labelFields', config.labelFields, NATIVE_LABEL_FIELDS, 'given a label'],
  ];
  for (const [key, written, natives, what] of checks) {
    for (const native of natives) {
      if (!hasEntry(written, native)) {
        report(
          file,
          `${key} has no ${native} \u2014 Roku list items won't be ${what}`,
          DiagnosticSeverity.Warning,
          range,
        );
      }
    }
  }
}

export function analyzeProgram(program: Program, config: VibeviewConfig): Analysis {
  const analysis: Analysis = {
    plans: new Map(),
    initTables: new Map(),
    needsHelper: new Set(),
    stripIds: new Set(),
  };
  const files = Object.values(program.files) as BscFile[];

  // Re-analysis (watch mode, language server) must not stack up our earlier diagnostics.
  for (const file of files) {
    file.diagnostics = file.diagnostics.filter((d) => d.code !== DIAGNOSTIC_CODE);
  }

  for (const file of files) {
    if (!isBrsFile(file) || isHelper(file)) continue;
    for (const callable of file.callables) {
      const emitted = callable.getName(ParseMode.BrightScript) ?? callable.name;
      if (emitted.toLowerCase().startsWith('vibeview_')) {
        report(
          file,
          `function ${emitted} uses the reserved vibeview_ prefix; rename it`,
          DiagnosticSeverity.Error,
          callable.nameRange ?? callable.range,
        );
      }
    }
  }

  // Sorted, so an init table's key order (and so the emitted code) never depends on the
  // order bsc happens to hold its files in.
  const xmlFiles = files
    .filter(isXmlFile)
    .filter((f) => !!f.componentName?.text)
    .sort((a, b) => (lower(a.pkgPath) < lower(b.pkgPath) ? -1 : 1));
  if (config.enabled && xmlFiles.length > 0) reportEffectiveLists(xmlFiles[0], config);
  const helperWanted = new Set<string>();
  const scopeFilesByName = new Map<string, BscFile[]>();

  for (const file of xmlFiles) {
    const name = file.componentName.text;
    const ids = collectIds(file);
    if (ids.length > 0 || /vibeviewId\s*=/i.test(file.fileContents ?? '')) {
      analysis.stripIds.add(lower(file.pkgPath));
    }

    const scope = program.getComponentScope(name);
    const scopeFiles = (scope?.getAllFiles() ?? []) as BscFile[];
    scopeFilesByName.set(name.toLowerCase(), scopeFiles);
    if (scopeFiles.some((f) => !isHelper(f) && CALLS_HELPER.test(f.fileContents ?? ''))) {
      helperWanted.add(name.toLowerCase());
    }
    if (!config.enabled) continue;

    const field = chooseField(file, name, config);
    if (!field && ids.length === 0) continue;
    if (hasInlineCode(file)) {
      report(
        file,
        `${name}: has inline <script> code; move it to a .brs file to be marked (skipped)`,
        DiagnosticSeverity.Warning,
        file.componentName.range,
      );
      continue;
    }
    const init = resolveInit(scope);
    const initPkgPath = init ? lower(init.file.pkgPath) : undefined;
    const plan: ComponentPlan = {
      name,
      xmlPkgPath: lower(file.pkgPath),
      ids,
      ...(field ? { field } : {}),
      ...(initPkgPath ? { initPkgPath } : {}),
    };
    analysis.plans.set(name.toLowerCase(), plan);
    helperWanted.add(name.toLowerCase());
    if (initPkgPath) {
      const table = analysis.initTables.get(initPkgPath) ?? {};
      table[name] = { ...(field ? { field } : {}), ...(ids.length ? { ids } : {}) };
      analysis.initTables.set(initPkgPath, table);
    }
    if (scopeFiles.some((f) => !isHelper(f) && INDEXES_TOP_CHILDREN.test(f.fileContents ?? ''))) {
      report(
        file,
        `${name}: its scripts index m.top's children; the marker is appended as the last child`,
        DiagnosticSeverity.Warning,
        file.componentName.range,
      );
    }
    report(
      file,
      `${name}: marked${field ? ` by field ${field}` : ''}${ids.length ? `, ${ids.length} test id(s)` : ''}`,
      DiagnosticSeverity.Hint,
      file.componentName.range,
    );
  }

  // An injected init() runs in every component whose scope holds its file, marked or not:
  // an unmarked component sharing the file, or an unmarked parent whose init a marked child
  // inherits (every plain parent instance runs it too). Each needs vibeview_autoMark.
  for (const [name, scopeFiles] of scopeFilesByName) {
    if (scopeFiles.some((f) => analysis.initTables.has(lower(f.pkgPath)))) helperWanted.add(name);
  }

  // The helper tag goes on each component that wants it, unless an ancestor gets it
  // (a component inherits its ancestors' scripts, and bsc flags a duplicate import).
  const byName = new Map(xmlFiles.map((f) => [f.componentName.text.toLowerCase(), f]));
  for (const wanted of helperWanted) {
    const file = byName.get(wanted)!;
    let ancestorHas = false;
    const seen = new Set<XmlFile>([file]);
    for (let p = file.parentComponent; p && !seen.has(p); p = p.parentComponent) {
      seen.add(p);
      if (helperWanted.has(p.componentName?.text.toLowerCase() ?? '')) ancestorHas = true;
    }
    if (!ancestorHas) analysis.needsHelper.add(lower(file.pkgPath));
  }
  return analysis;
}
