import { createSGAttribute, isCommentStatement, Parser, SGScript } from 'brighterscript';
import type { BrsFile, Editor, SGNode, XmlFile } from 'brighterscript';
import { HELPER_URI } from './runtime';

export type AutoMarkTable = Record<string, { field?: string; ids?: [string, string][] }>;

export const autoMarkCall = (table: AutoMarkTable) => `vibeview_autoMark(${JSON.stringify(table)})`;

/**
 * `<script type="text/brightscript" uri="pkg:/components/vibeview/vibeview.brs" />`, built the
 * way bsc builds the imports it adds itself. Only a fallback: normally bsc adds this import.
 */
export function addHelperTag(file: XmlFile, editor: Editor) {
  const tag = new SGScript({ text: 'script' }, [
    createSGAttribute('type', 'text/brightscript'),
    createSGAttribute('uri', HELPER_URI),
  ]);
  editor.arrayPush(file.ast.component!.scripts, tag);
}

/** An inline `<script>` holding an init() that only calls autoMark. */
export function addInlineInit(file: XmlFile, editor: Editor, table: AutoMarkTable) {
  const code = `<![CDATA[\nsub init()\n    ${autoMarkCall(table)}\nend sub\n]]>`;
  const tag = new SGScript({ text: 'script' }, [createSGAttribute('type', 'text/brightscript')], {
    text: code,
  });
  editor.arrayPush(file.ast.component!.scripts, tag);
}

/** Remove every vibeviewId attribute (any case) from the component's children. */
export function stripVibeviewIds(file: XmlFile, editor: Editor) {
  const visit = (nodes: SGNode[] | undefined) => {
    for (const node of nodes ?? []) {
      // Walk backwards so removals do not shift the indexes still to visit.
      for (let i = node.attributes.length - 1; i >= 0; i--) {
        if (node.attributes[i].key.text.toLowerCase() === 'vibeviewid') {
          editor.removeFromArray(node.attributes, i);
        }
      }
      visit(node.children);
    }
  };
  visit(file.ast.component?.children?.children);
}

/** Make `vibeview_autoMark(table)` the first executable statement of the file's own init(). */
export function injectIntoInit(file: BrsFile, editor: Editor, table: AutoMarkTable): boolean {
  const init = file.callables.find((c) => !c.hasNamespace && c.name.toLowerCase() === 'init');
  const func = init?.functionStatement?.func;
  const statements = func?.body.statements;
  if (!func || !statements) return false;
  // A comment on the `sub init()` line stays there: insert after it, not before it.
  const headerLine = func.range?.start.line;
  let index = 0;
  while (
    index < statements.length &&
    isCommentStatement(statements[index]) &&
    statements[index].range?.start.line === headerLine
  ) {
    index++;
  }
  const code = autoMarkCall(table);
  const [call] = Parser.parse(code).ast.statements;
  editor.addToArray(statements, index, call);
  // bsc would pretty-print the table across many lines; emit the one-line call instead.
  editor.overrideTranspileResult(call, code);
  return true;
}
