import { describe, expect, it } from 'vitest';
import { Program } from 'brighterscript';
import { helperScript, HELPER_PKG_PATH } from './runtime';

function diagnosticsFor(code: string) {
  // 1013 (file not referenced by any other file) is a project-level hint for a
  // lone helper in an otherwise empty program, not a statement about the code.
  const program = new Program({ rootDir: '/tmp/vv-runtime', diagnosticFilters: [1013] });
  program.setFile(HELPER_PKG_PATH, code);
  // A component importing the helper puts it in a scope, so calls (unknown builtins,
  // argument counts) are checked too, not just syntax.
  program.setFile(
    'components/C.xml',
    `<?xml version="1.0" encoding="utf-8" ?>
<component name="C" extends="Group">
  <script type="text/brightscript" uri="pkg:/components/vibeview/vibeview.brs" />
</component>
`,
  );
  program.validate();
  return program.getDiagnostics().map((d) => `${d.code}: ${d.message}`);
}

describe('helperScript', () => {
  it('enabled helper parses and validates cleanly', () => {
    expect(diagnosticsFor(helperScript(true))).toEqual([]);
  });
  it('disabled helper parses cleanly and only has the no-op markup functions', () => {
    const code = helperScript(false);
    expect(diagnosticsFor(code)).toEqual([]);
    expect(code).toMatch(/sub vibeview_setHighlight\(node as Dynamic, on as Dynamic\)\s*end sub/);
    expect(code).toMatch(/sub vibeview_setId\(node as Dynamic, id as Dynamic\)\s*end sub/);
    expect(code).not.toContain('vibeview_autoMark');
  });
  // bsc checks only the argument count of a call, and BrightScript raises a Type Mismatch
  // crash when an argument does not fit a typed parameter. An app's data (a ParseJSON
  // number, an invalid) must never crash the channel through the helpers.
  for (const enabled of [true, false]) {
    it(`${enabled ? 'enabled' : 'disabled'} helper: public functions take only Dynamic params`, () => {
      const code = helperScript(enabled);
      for (const name of ['vibeview_setHighlight', 'vibeview_setId']) {
        const header = code.match(new RegExp(`sub ${name}\\(([^)]*)\\)`))![1];
        expect(header.split(',').map((p) => p.trim().split(/\s+as\s+/i)[1])).toEqual([
          'Dynamic',
          'Dynamic',
        ]);
      }
    });
  }
  it('the enabled helper coerces a numeric id to text and ignores other types', () => {
    const code = helperScript(true);
    const fn = code.slice(code.indexOf('function vibeview_idText'));
    const body = fn.slice(0, fn.indexOf('end function'));
    expect(body).toContain('ToStr()');
    expect(body).toMatch(/roFloat|Float/);
    expect(code).toMatch(
      /sub vibeview_setId\(node as Dynamic, id as Dynamic\)\s+if Type\(node\) <> "roSGNode" then return\s+idText = vibeview_idText\(id\)/,
    );
  });
  it('the enabled helper looks markers up among direct children only', () => {
    const code = helperScript(true);
    expect(code).toContain('getChildren(-1, 0)');
    expect(code).not.toContain('findNode("vibeviewMarker")');
  });
  it('the enabled helper sizes a new marker 1x1 so it adds nothing to the node bounds', () => {
    const code = helperScript(true);
    const create = code.slice(code.indexOf('marker = node.createChild("Label")'));
    const block = create.slice(0, create.indexOf('return marker'));
    expect(block).toContain('marker.visible = false');
    expect(block).toMatch(/^\s*marker\.width = 1$/m);
    expect(block).toMatch(/^\s*marker\.height = 1$/m);
  });
});

describe('identity helper', () => {
  const identity = { idFields: ['itemContent._id', 'id'], labelFields: ['itemContent.title'] };
  it('enabled helper with identity lists validates cleanly', () => {
    expect(diagnosticsFor(helperScript(true, identity))).toEqual([]);
  });
  it('writes the configured lists once into vibeview_identityConfig', () => {
    const code = helperScript(true, identity);
    expect(code).toContain('function vibeview_identityConfig() as Object');
    expect(code).toContain(
      'return {ids: ["itemContent._id", "id"], labels: ["itemContent.title"]}',
    );
  });
  it('empty lists still produce a valid helper', () => {
    expect(diagnosticsFor(helperScript(true, { idFields: [], labelFields: [] }))).toEqual([]);
    expect(helperScript(true)).toContain('return {ids: [], labels: []}');
  });
  it('disabled helper is unchanged by identity lists', () => {
    expect(helperScript(false, identity)).toBe(helperScript(false));
  });
  it('watches the first segment of every path so recycled items refresh', () => {
    const code = helperScript(true, identity);
    expect(code).toContain('m.top.observeField(field, "vibeview_onIdentity")');
    expect(code).toContain('seen[path.split(".")[0]] = true');
  });
  it('label is written last and an explicit id is preserved', () => {
    const code = helperScript(true, identity);
    expect(code).toMatch(/out = out \+ " label=" \+ curLabel/);
    expect(code).toContain('m.vibeview_fieldId');
  });
});
