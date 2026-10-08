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

  it("a subclass follows its nearest ancestor's override unless it has its own", () => {
    const sub = (name: string, parent: string) =>
      xml(name, `<script type="text/brightscript" uri="${name}.brs" />`, parent);
    const p = makeProgram({
      'components/SearchBar.xml': item('SearchBar'),
      'components/SearchBar.brs': initBrs,
      'components/SearchBarV2.xml': sub('SearchBarV2', 'SearchBar'),
      'components/SearchBarV2.brs': initBrs,
      'components/SearchBarV3.xml': sub('SearchBarV3', 'SearchBarV2'),
      'components/SearchBarV3.brs': initBrs,
      'components/PromoTile.xml': xml(
        'PromoTile',
        '<interface><field id="isFocused" type="boolean" /><field id="selected" type="boolean" /></interface>\n<script type="text/brightscript" uri="PromoTile.brs" />',
      ),
      'components/PromoTile.brs': initBrs,
      'components/PromoTileWide.xml': sub('PromoTileWide', 'PromoTile'),
      'components/PromoTileWide.brs': initBrs,
    });
    const a = analyzeProgram(
      p,
      cfg({
        enabled: true,
        highlightFields: ['isFocused'],
        components: { SearchBar: false, searchbarv3: 'isFocused', PromoTile: 'selected' },
      }),
    );
    expect(a.plans.has('searchbar')).toBe(false);
    expect(a.plans.has('searchbarv2')).toBe(false);
    expect(a.plans.get('searchbarv3')?.field).toBe('isFocused');
    expect(a.plans.get('promotilewide')?.field).toBe('selected');
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

  it("a subclass inherits its ancestors' vibeviewId ids", () => {
    const parent = xml(
      'Parent',
      '<script type="text/brightscript" uri="Parent.brs" />\n<children><Poster id="icon" vibeviewId="nav-icon" /></children>',
    );
    const p = makeProgram({
      'components/Parent.xml': parent,
      'components/Parent.brs': initBrs,
      // No script of its own: runs Parent's init with subtype() "Child".
      'components/Child.xml': xml('Child', '', 'Parent'),
      // Its own field, init and id.
      'components/Child2.xml': xml(
        'Child2',
        '<interface><field id="isFocused" type="boolean" /></interface>\n<script type="text/brightscript" uri="Child2.brs" />\n<children><Label id="title" vibeviewId="t" /></children>',
        'Parent',
      ),
      'components/Child2.brs': initBrs,
      'components/Grand.xml': xml(
        'Grand',
        '<children><Label id="icon2" vibeviewId="x" /></children>',
        'Child2',
      ),
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused'] }));
    expect(a.initTables.get('components/parent.brs')).toEqual({
      Child: { ids: [['icon', 'nav-icon']] },
      Parent: { ids: [['icon', 'nav-icon']] },
    });
    expect(a.initTables.get('components/child2.brs')).toEqual({
      Child2: {
        field: 'isFocused',
        ids: [
          ['icon', 'nav-icon'],
          ['title', 't'],
        ],
      },
      Grand: {
        field: 'isFocused',
        ids: [
          ['icon', 'nav-icon'],
          ['title', 't'],
          ['icon2', 'x'],
        ],
      },
    });
    // Ids are stripped only from the XML that declares them; errors are not repeated.
    expect(a.stripIds.has('components/child.xml')).toBe(false);
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

  it("a .d.bs typedef's init() is mapped to the .brs file that implements it", () => {
    const p = makeProgram({
      'components/Nav.xml': item('Nav'),
      'components/Nav.brs': 'sub init()\n    print "x"\nend sub\n',
      'components/Nav.d.bs': 'sub init()\nend sub\n',
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused'] }));
    expect(a.plans.get('nav')?.initPkgPath).toBe('components/nav.brs');
    expect([...a.initTables.keys()]).toEqual(['components/nav.brs']);
  });

  it('a typedef init() with no implementation in the project skips the component', () => {
    const p = makeProgram({
      'components/Lib.xml': xml(
        'Lib',
        '<interface><field id="isFocused" type="boolean" /></interface>\n<script type="text/brightscript" uri="Lib.d.bs" />',
      ),
      'components/Lib.d.bs': 'sub init()\nend sub\n',
    });
    const a = analyzeProgram(p, cfg({ enabled: true, highlightFields: ['isFocused'] }));
    expect(a.plans.has('lib')).toBe(false);
    expect(a.initTables.size).toBe(0);
    expect(diags(p)).toContain(
      'vibeview: Lib: its init() is declared only in a .d.bs typedef; the file that implements it is not in the project (skipped)',
    );
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

  describe('marker vs child indexing', () => {
    const focusable = (name: string, children = '') =>
      xml(
        name,
        `<interface><field id="isFocused" type="boolean" /></interface>\n<script type="text/brightscript" uri="${name}.brs" />${children}`,
      );
    const plain = (name: string, children = '') =>
      xml(name, `<script type="text/brightscript" uri="${name}.brs" />${children}`);
    const warnings = (files: Record<string, string>, enabled = true) => {
      const p = makeProgram(files);
      analyzeProgram(p, cfg({ enabled, highlightFields: ['isFocused'] }));
      return p
        .getDiagnostics()
        .filter((d) => d.code === 'vibeview' && d.severity === 2)
        .map(text)
        .filter((m) => m.includes('children'));
    };

    it('warns when a field-marked component indexes m.top (getChild, getChildCount)', () => {
      const w = warnings({
        'components/Top.xml': focusable('Top'),
        'components/Top.brs':
          'sub init()\n    m.top.getChild(m.top.getChildCount() - 1)\nend sub\n',
      });
      expect(w).toEqual([expect.stringMatching(/^vibeview: Top: .*m\.top/)]);
    });

    it('warns for getChildren on m.top', () => {
      const w = warnings({
        'components/Tile.xml': focusable('Tile'),
        'components/Tile.brs':
          'sub init()\n    for each c in m.top.getChildren(-1, 0)\n        c.opacity = 0.5\n    end for\nend sub\n',
      });
      expect(w).toEqual([expect.stringMatching(/^vibeview: Tile: .*m\.top/)]);
    });

    it('warns when a vibeviewId element is indexed through the variable holding it', () => {
      const w = warnings({
        'components/Menu.xml': plain(
          'Menu',
          '<children><LayoutGroup id="menu" vibeviewId="main-menu"><Label id="a" /></LayoutGroup></children>',
        ),
        'components/Menu.brs':
          'sub init()\n    m.menu = m.top.findNode("menu")\n    m.menu.getChild(m.menu.getChildCount() - 1).setFocus(true)\nend sub\n',
      });
      expect(w).toEqual([expect.stringMatching(/^vibeview: Menu: .*m\.menu/)]);
    });

    it('warns when a vibeviewId element is indexed through findNode directly', () => {
      const w = warnings({
        'components/Menu.xml': plain(
          'Menu',
          '<children><LayoutGroup id="menu" vibeviewId="main-menu"><Label id="a" /></LayoutGroup></children>',
        ),
        'components/Menu.brs':
          'sub init()\n    m.top.findNode("menu").getChildren(-1, 0)\nend sub\n',
      });
      expect(w).toHaveLength(1);
    });

    it('warns when a node passed to the helpers by hand is indexed', () => {
      const w = warnings({
        'components/Hand.xml': plain('Hand'),
        'components/Hand.brs':
          'sub init()\n    vibeview_setId(m.top, "hand")\n    m.top.getChild(m.top.getChildCount() - 1).setFocus(true)\nend sub\n',
        'components/Row.xml': plain('Row'),
        'components/Row.brs':
          'sub init()\n    m.row = m.top.findNode("row")\n    vibeview_setHighlight(m.row, true)\n    first = m.row.getChild(0)\nend sub\n',
      });
      expect(w).toEqual([
        expect.stringMatching(/^vibeview: Hand: .*m\.top/),
        expect.stringMatching(/^vibeview: Row: .*m\.row/),
      ]);
    });

    it('stays quiet for nodes that get no marker, comments and store builds', () => {
      const files = {
        // ids only: m.top itself gets no marker.
        'components/Ids.xml': plain(
          'Ids',
          '<children><Poster id="p" vibeviewId="poster" /></children>',
        ),
        'components/Ids.brs': 'sub init()\n    m.top.getChild(0)\nend sub\n',
        // marked by a field, but indexes another node.
        'components/List.xml': focusable('List'),
        'components/List.brs':
          'sub init()\n    m.list = m.top.findNode("list")\n    m.list.getChild(0)\nend sub\n',
        // only a comment indexes m.top.
        'components/Quiet.xml': focusable('Quiet'),
        'components/Quiet.brs':
          'sub init()\n    \' m.top.getChild(0)\n    m.x = "m.top.getChild(" \' too\nend sub\n',
      };
      expect(warnings(files)).toEqual([]);
      expect(
        warnings(
          {
            'components/Top.xml': focusable('Top'),
            'components/Top.brs': 'sub init()\n    m.top.getChild(0)\nend sub\n',
          },
          false,
        ),
      ).toEqual([]);
    });
  });

  describe('list items with no highlight field', () => {
    const itemXml = (name: string, fields: string) =>
      xml(
        name,
        `<interface>${fields}</interface>\n<script type="text/brightscript" uri="${name}.brs" />`,
      );
    const files = {
      'components/Screen.xml': xml(
        'Screen',
        '<script type="text/brightscript" uri="Screen.brs" />\n<children><RowList id="rows" itemComponentName="RowItem" /><MarkupGrid id="grid2" itemComponentName="RowItem2" /></children>',
      ),
      'components/Screen.brs':
        'sub init()\n    m.grid = m.top.findNode("grid")\n    m.grid.itemComponentName = "Cell"\nend sub\n',
      'components/RowItem.xml': itemXml(
        'RowItem',
        '<field id="itemContent" type="node" /><field id="focusPercent" type="float" /><field id="rowListHasFocus" type="boolean" />',
      ),
      'components/RowItem.brs': initBrs,
      'components/RowItem2.xml': itemXml(
        'RowItem2',
        '<field id="itemContent" type="node" /><field id="itemHasFocus" type="boolean" />',
      ),
      'components/RowItem2.brs': initBrs,
      'components/Cell.xml': itemXml('Cell', '<field id="label" type="string" />'),
      'components/Cell.brs': initBrs,
      'components/Card.xml': itemXml('Card', '<field id="itemContent" type="node" />'),
      'components/Card.brs': initBrs,
      'components/Panel.xml': itemXml('Panel', '<field id="title" type="string" />'),
      'components/Panel.brs': initBrs,
    };
    const notes = (enabled: boolean) => {
      const p = makeProgram(files);
      analyzeProgram(p, cfg({ enabled }));
      return p
        .getDiagnostics()
        .filter((d) => d.code === 'vibeview' && d.severity === 3)
        .map(text)
        .filter((m) => m.includes('no highlight field'));
    };

    it('notes each list item component, or itemContent holder, that declares no highlight field', () => {
      expect(notes(true).sort()).toEqual([
        'vibeview: Card: holds itemContent but declares no highlight field (itemHasFocus); it is not marked. If a list uses it, declare <field id="itemHasFocus" type="boolean" /> so the list sets it',
        'vibeview: Cell: list item component declares no highlight field (itemHasFocus); it is not marked. Declare <field id="itemHasFocus" type="boolean" /> so the list sets it',
        'vibeview: RowItem: list item component declares no highlight field (itemHasFocus); it is not marked. Declare <field id="itemHasFocus" type="boolean" /> so the list sets it',
      ]);
    });

    it('says nothing when markers are off', () => {
      expect(notes(false)).toEqual([]);
    });
  });
});
