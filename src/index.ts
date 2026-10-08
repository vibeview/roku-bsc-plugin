import { DiagnosticSeverity, isBrsFile, isXmlFile, util } from 'brighterscript';
import type {
  BeforeFileTranspileEvent,
  CompilerPlugin,
  DependencyGraph,
  Program,
} from 'brighterscript';
import { analyzeProgram, DIAGNOSTIC_CODE, type Analysis } from './analyze';
import { resolveConfig, type VibeviewConfig } from './config';
import { addHelperTag, addInlineInit, injectIntoInit, stripVibeviewIds } from './edits';
import { helperScript, HELPER_PKG_PATH } from './runtime';

const lower = (s: string) => s.replace(/\\/g, '/').toLowerCase();
/** Whether a dependency-graph key (or pkgPath) is the helper's, whatever its separators. */
const isHelperKey = (key: string) => lower(key) === lower(HELPER_PKG_PATH);

function dependencyGraphOf(program: Program): DependencyGraph {
  const graph = (program as unknown as { dependencyGraph?: DependencyGraph }).dependencyGraph;
  if (!graph) throw new Error('unsupported brighterscript version (no dependency graph)');
  return graph;
}

export default function vibeviewPlugin(): CompilerPlugin {
  let config: VibeviewConfig = resolveConfig(undefined);
  let analysis: Analysis | undefined;
  /** A file was parsed or disposed since the last analysis. */
  let stale = true;
  /**
   * Dependency-graph keys of components we made depend on the helper, each with the helper
   * key the edge points at (removing an edge needs the exact key it was added with).
   */
  const wired = new Map<string, string>();

  /**
   * Make each component in `needsHelper` depend on the helper, the same way a `.bs` import
   * statement does. Its scope then sees the helper's functions during validation, and bsc's
   * transpile adds the `<script>` import itself (skipping a child whose ancestor has it).
   * Idempotent: safe to run again right before transpile.
   */
  function wireHelper(program: Program, needsHelper: Set<string>) {
    const current = program.getFile(HELPER_PKG_PATH);
    const wanted = helperScript(config.enabled, config);
    const importedByHand = Object.values(program.files).some(
      (f) => isXmlFile(f) && f.scriptTagImports.some((i) => isHelperKey(i.pkgPath)),
    );
    if (needsHelper.size === 0 && !importedByHand) {
      // Nobody needs the helper (store build, no markup): ship nothing extra. A hand-written
      // import of it keeps it, or that import would point at a missing file.
      if (current) program.removeFile(HELPER_PKG_PATH);
    } else if (current?.fileContents !== wanted) {
      // Absent (watch mode: an earlier pass removed it) or replaced by a project file at
      // the same path (a hand-copied helper): ours, matching this build's setting, wins.
      program.setFile(HELPER_PKG_PATH, wanted);
    }
    if (needsHelper.size === 0 && wired.size === 0) return;
    const graph = dependencyGraphOf(program);
    // bsc's own key for the helper: the scope finds a dependency by exact key, and bsc
    // keys files by their platform pkgPath (backslashes on Windows).
    const helperKey = program.getFile(HELPER_PKG_PATH)?.dependencyGraphKey;
    for (const file of Object.values(program.files)) {
      if (!isXmlFile(file)) continue;
      const key = file.dependencyGraphKey;
      if (helperKey && needsHelper.has(lower(file.pkgPath))) {
        // Re-parsing a file replaces its graph node, so check the graph, not `wired`.
        // A component that imports the helper by hand already depends on it.
        if (!file.getOwnDependencies().some(isHelperKey)) {
          graph.addDependency(key, helperKey);
          wired.set(key, helperKey);
        }
      } else if (wired.has(key)) {
        graph.removeDependency(key, wired.get(key)!);
        wired.delete(key);
      }
    }
  }

  /** Analyze (when anything changed) and wire the helper in. */
  function prepare(program: Program) {
    const next = stale || !analysis ? analyzeProgram(program, config) : analysis;
    try {
      wireHelper(program, next.needsHelper);
      analysis = next;
    } catch (err) {
      // Never inject a marker call that might lack its import. Keep stripping ids, and give
      // helper callers the import through the transpile fallback below.
      analysis = { ...next, plans: new Map(), initTables: new Map() };
      const reason = err instanceof Error ? err.message : String(err);
      for (const file of Object.values(program.files)) {
        if (!isXmlFile(file) || !next.needsHelper.has(lower(file.pkgPath))) continue;
        file.addDiagnostics([
          {
            message: `vibeview: could not wire in the helper script (${reason}); markers are off`,
            code: DIAGNOSTIC_CODE,
            range: file.componentName?.range ?? util.createRange(0, 0, 0, 0),
            file,
            severity: DiagnosticSeverity.Error,
          },
        ]);
      }
    }
    // Our own setFile of the helper above counts as a change; it is accounted for.
    stale = false;
  }

  return {
    name: '@vibeview/roku-bsc-plugin',

    afterProgramCreate(program: Program) {
      // bsc keeps unknown bsconfig keys on the finalized options.
      config = resolveConfig((program.options as { vibeview?: unknown }).vibeview);
      program.setFile(HELPER_PKG_PATH, helperScript(config.enabled, config));
    },

    afterFileParse() {
      stale = true;
    },

    afterFileDispose() {
      stale = true;
    },

    beforeProgramValidate(program: Program) {
      // Every file is parsed by now. Decide before validation, so calls to the markup
      // helpers validate against the helper and it is never reported as unreferenced.
      stale = true;
      prepare(program);
    },

    beforeProgramTranspile(program: Program) {
      // With `validate: false` no validation ran; another plugin may also have changed files
      // (or dropped our graph edges) since. Re-analyze if anything changed, and re-wire.
      prepare(program);
    },

    beforeFileTranspile(event: BeforeFileTranspileEvent) {
      if (!analysis) return;
      // bsc marks the file for re-emit itself when the editor has changes, and undoes
      // every editor change after transpile, so the program's AST stays pristine.
      const { file, editor } = event;
      const key = lower(file.pkgPath);
      if (isXmlFile(file)) {
        if (analysis.stripIds.has(key)) stripVibeviewIds(file, editor);
        // bsc adds the import from the graph edge; if the edge is gone (or could not be
        // added), add the tag ourselves rather than ship a component that calls a missing
        // function. getAllDependencies covers an ancestor that already imports it.
        if (analysis.needsHelper.has(key) && !file.getAllDependencies().some(isHelperKey)) {
          addHelperTag(file, editor);
        }
        const plan = analysis.plans.get(file.componentName?.text.toLowerCase() ?? '');
        if (plan && plan.xmlPkgPath === key && !plan.initPkgPath) {
          addInlineInit(file, editor, {
            [plan.name]: {
              ...(plan.field ? { field: plan.field } : {}),
              ...(plan.ids.length ? { ids: plan.ids } : {}),
            },
          });
        }
      } else if (isBrsFile(file)) {
        const table = analysis.initTables.get(key);
        if (table) injectIntoInit(file, editor, table);
      }
    },
  };
}
