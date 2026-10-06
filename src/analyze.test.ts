import { describe, expect, it } from 'vitest';
import { analyzeProgram } from './analyze';
import { resolveConfig } from './config';
import { makeProgram, xml } from './test-helpers';

const cfg = (raw: unknown) => resolveConfig(raw, {});
const item = (name: string, field = 'isFocused', type = 'boolean') =>
  xml(
    name,
    `<interface><field id="${field}" type="${type}" /></interface>\n<script type="text/brightscript" uri="${name}.brs" />`,
  );
const initBrs = 'sub init()\n    m.x = 1\nend sub\n';
// Diagnostic.message is typed string | MarkupContent; ours are always plain strings.
const text = (d: { message: string | { value: string } }) =>
  typeof d.message === 'string' ? d.message : d.message.value;
const diags = (p: ReturnType<typeof makeProgram>) => p.getDiagnostics().map(text);

describe('analyzeProgram', () => {
  it('picks the first candidate field the component declares as boolean', () => {
    const p = makeProgram({
      'components/A.xml': item('A', 'focused'),
      'components/A.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused', 'focused'] }));
    expect(a.plans.get('a')?.field).toBe('focused');
    expect(a.initTables.get('components/a.brs')).toEqual({ A: { field: 'focused' } });
    expect(a.needsHelper.has('components/a.xml')).toBe(true);
  });

  it("marks a component declaring Roku's native itemHasFocus with no highlightFields configured", () => {
    const p = makeProgram({
      'components/A.xml': item('A', 'itemHasFocus'),
      'components/A.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true }));
    expect(a.plans.get('a')?.field).toBe('itemHasFocus');
    expect(a.initTables.get('components/a.brs')).toEqual({ A: { field: 'itemHasFocus' } });
  });

  describe('effective lists diagnostic', () => {
    const files = { 'components/A.xml': item('A', 'itemHasFocus'), 'components/A.brs': initBrs };
    const run = (raw: unknown) => {
      const p = makeProgram(files);
      analyzeProgram(p, cfg(raw));
      return p.getDiagnostics().filter((d) => d.code === 'vibeview');
    };

    it('lists the effective lists once, with no warning when the natives are used', () => {
      const d = run({ enabled: true });
      const info = d.filter((x) => x.severity === 3);
      expect(info.map(text)).toEqual([
        'vibeview: highlight [itemHasFocus], ids [itemContent.id], labels [itemContent.title]',
      ]);
      expect(d.filter((x) => x.severity === 2)).toEqual([]);
    });

    it('warns for each written list that omits its native entry', () => {
      const d = run({
        enabled: true,
        highlightFields: ['isFocused'],
        idFields: ['id'],
        labelFields: ['name'],
      });
      expect(d.map(text)).toEqual(
        expect.arrayContaining([
          'vibeview: highlight [isFocused], ids [id], labels [name]',
          "vibeview: highlightFields has no itemHasFocus \u2014 Roku list items won't be marked",
          "vibeview: idFields has no itemContent.id \u2014 Roku list items won't be given an id",
          "vibeview: labelFields has no itemContent.title \u2014 Roku list items won't be given a label",
        ]),
      );
    });

    it('does not warn for a native written in another case', () => {
      const d = run({ enabled: true, highlightFields: ['ITEMHASFOCUS'] });
      expect(d.map(text).some((m) => m.includes('highlightFields has no'))).toBe(false);
    });

    it('says nothing when markers are off', () => {
      expect(run({ enabled: false, highlightFields: ['isFocused'] })).toEqual([]);
    });
  });

  it('skips a non-boolean candidate with a warning and takes the next', () => {
    const p = makeProgram({
      'components/A.xml': xml(
        'A',
        '<interface><field id="isFocused" type="string" /><field id="focused" type="boolean" /></interface>\n<script type="text/brightscript" uri="A.brs" />',
      ),
      'components/A.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused', 'focused'] }));
    expect(a.plans.get('a')?.field).toBe('focused');
  });

  it('accepts SceneGraph "bool" and any casing as a boolean field type', () => {
    const p = makeProgram({
      'components/A.xml': item('A', 'isFocused', 'bool'),
      'components/A.brs': initBrs,
      'components/B.xml': item('B', 'isFocused', 'Boolean'),
      'components/B.brs': initBrs,
      'components/C.xml': item('C', 'isFocused', 'BOOL'),
      'components/C.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused'] }));
    expect(a.plans.get('a')?.field).toBe('isFocused');
    expect(a.plans.get('b')?.field).toBe('isFocused');
    expect(a.plans.get('c')?.field).toBe('isFocused');
    expect(diags(p).some((m) => m.includes('not a boolean'))).toBe(false);
  });

  it('an override may name a "bool" field', () => {
    const p = makeProgram({
      'components/A.xml': item('A', 'selected', 'bool'),
      'components/A.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true, components: { A: 'selected' } }));
    expect(a.plans.get('a')?.field).toBe('selected');
  });

  it('honours per-component overrides: false skips, a string chooses', () => {
    const p = makeProgram({
      'components/A.xml': item('A'),
      'components/A.brs': initBrs,
      'components/B.xml': item('B', 'isActive'),
      'components/B.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true, components: { A: false, B: 'isActive' } }));
    expect(a.plans.has('a')).toBe(false);
    expect(a.plans.get('b')?.field).toBe('isActive');
  });

  it('warns when an override names a missing field', () => {
    const p = makeProgram({ 'components/B.xml': item('B'), 'components/B.brs': initBrs });
    analyzeProgram(p, cfg({ enabled: true, components: { B: 'nope' } }));
    expect(diags(p).some((m) => m.includes('B') && m.includes('nope'))).toBe(true);
  });

  it('a field declared on a parent component counts (inheritance)', () => {
    const p = makeProgram({
      'components/Base.xml': item('Base'),
      'components/Base.brs': initBrs,
      'components/Child.xml': xml(
        'Child',
        '<script type="text/brightscript" uri="Child.brs" />',
        'Base',
      ),
      'components/Child.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused'] }));
    expect(a.plans.get('child')?.field).toBe('isFocused');
    expect(a.initTables.get('components/child.brs')).toEqual({ Child: { field: 'isFocused' } });
    // Base gets the helper; Child inherits it, so it is not added twice.
    expect(a.needsHelper.has('components/base.xml')).toBe(true);
    expect(a.needsHelper.has('components/child.xml')).toBe(false);
  });

  it('a child without its own init() is keyed into the init() it inherits', () => {
    const p = makeProgram({
      'components/Base.xml': item('Base'),
      'components/Base.brs': initBrs,
      'components/Child.xml': xml('Child', '', 'Base'),
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused'] }));
    expect(a.initTables.get('components/base.brs')).toEqual({
      Base: { field: 'isFocused' },
      Child: { field: 'isFocused' },
    });
  });

  it('two components sharing one init file share one table', () => {
    const shared = (n: string) =>
      xml(
        n,
        '<interface><field id="isFocused" type="boolean" /></interface>\n<script type="text/brightscript" uri="Shared.brs" />',
      );
    const p = makeProgram({
      'components/A.xml': shared('A'),
      'components/B.xml': shared('B'),
      'components/Shared.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused'] }));
    expect(a.initTables.get('components/shared.brs')).toEqual({
      A: { field: 'isFocused' },
      B: { field: 'isFocused' },
    });
  });

  it('no init() anywhere leaves initPkgPath undefined', () => {
    const p = makeProgram({
      'components/A.xml': xml(
        'A',
        '<interface><field id="isFocused" type="boolean" /></interface>',
      ),
    });
    const a = analyzeProgram(p, cfg({ enabled: true }));
    expect(a.plans.get('a')?.initPkgPath).toBeUndefined();
  });

  it('skips a component with inline script code and warns', () => {
    const p = makeProgram({
      'components/A.xml': xml(
        'A',
        '<interface><field id="isFocused" type="boolean" /></interface>\n<script type="text/brightscript"><![CDATA[\nsub init()\nend sub\n]]></script>',
      ),
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused'] }));
    expect(a.plans.has('a')).toBe(false);
    expect(diags(p).some((m) => m.includes('inline'))).toBe(true);
  });

  it('collects vibeviewId attributes, requires an id, rejects bad ids', () => {
    const p = makeProgram({
      'components/A.xml': xml(
        'A',
        '<script type="text/brightscript" uri="A.brs" />\n<children>\n<Poster id="btnTrailer" vibeviewId="trailer" />\n<Poster vibeviewId="noid" />\n<Poster id="x" vibeviewId="bad id" />\n</children>',
      ),
      'components/A.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true }));
    expect(a.plans.get('a')?.ids).toEqual([['btnTrailer', 'trailer']]);
    expect(a.stripIds.has('components/a.xml')).toBe(true);
    const errors = p
      .getDiagnostics()
      .filter((d) => d.severity === 1)
      .map(text);
    expect(errors.some((m) => m.includes('needs an id'))).toBe(true);
    expect(errors.some((m) => m.includes('bad id'))).toBe(true);
  });

  it('rejects a vibeviewId whose element id is outside the safe charset', () => {
    const p = makeProgram({
      'components/A.xml': xml(
        'A',
        `<script type="text/brightscript" uri="A.brs" />\n<children>\n<Poster id="ok.id-1" vibeviewId="good" />\n<Poster id="has space" vibeviewId="spaced" />\n<Poster id='q"uote' vibeviewId="quoted" />\n</children>`,
      ),
      'components/A.brs': initBrs,
    });
    const a = analyzeProgram(p, cfg({ enabled: true }));
    expect(a.plans.get('a')?.ids).toEqual([['ok.id-1', 'good']]);
    const errors = p
      .getDiagnostics()
      .filter((d) => d.severity === 1)
      .map(text);
    expect(errors.filter((m) => m.includes('is not usable'))).toHaveLength(2);
    expect(errors.some((m) => m.includes('"has space"'))).toBe(true);
    expect(errors.some((m) => m.includes('q"uote'))).toBe(true);
  });

  it('errors when the app already defines a vibeview_ function', () => {
    const p = makeProgram({
      'components/A.xml': item('A'),
      'components/A.brs': initBrs + '\nsub vibeview_mine()\nend sub\n',
    });
    analyzeProgram(p, cfg({ enabled: true }));
    expect(
      p.getDiagnostics().some((d) => d.severity === 1 && text(d).includes('vibeview_mine')),
    ).toBe(true);
  });

  it('disabled: no plans, but strips ids and gives callers the no-op helper', () => {
    const p = makeProgram({
      'components/A.xml': xml(
        'A',
        '<script type="text/brightscript" uri="A.brs" />\n<children><Poster id="b" vibeviewId="t" /></children>',
      ),
      'components/A.brs': 'sub init()\n    vibeview_setHighlight(m.top, true)\nend sub\n',
    });
    const a = analyzeProgram(p, cfg({ enabled: false }));
    expect(a.plans.size).toBe(0);
    expect(a.initTables.size).toBe(0);
    expect(a.stripIds.has('components/a.xml')).toBe(true);
    expect(a.needsHelper.has('components/a.xml')).toBe(true);
  });

  it('an unmarked component that runs an injected init() needs the helper too', () => {
    const p = makeProgram({
      'components/A.xml': xml(
        'A',
        '<interface><field id="isFocused" type="boolean" /></interface>\n<script type="text/brightscript" uri="shared.brs" />',
      ),
      'components/B.xml': xml('B', '<script type="text/brightscript" uri="shared.brs" />'),
      'components/shared.brs': initBrs,
      'components/Base.xml': xml('Base', '<script type="text/brightscript" uri="Base.brs" />'),
      'components/Base.brs': initBrs,
      'components/Derived.xml': xml(
        'Derived',
        '<interface><field id="isFocused" type="boolean" /></interface>',
        'Base',
      ),
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused'] }));
    expect(a.initTables.get('components/shared.brs')).toEqual({ A: { field: 'isFocused' } });
    expect(a.initTables.get('components/base.brs')).toEqual({ Derived: { field: 'isFocused' } });
    // B runs shared.brs's init; Base runs its own; Derived inherits Base's import.
    expect([...a.needsHelper].sort()).toEqual([
      'components/a.xml',
      'components/b.xml',
      'components/base.xml',
    ]);
  });
});
