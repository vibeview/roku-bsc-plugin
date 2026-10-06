import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProgramBuilder } from 'brighterscript';
import type { CompilerPlugin as Plugin, Program } from 'brighterscript';
import vibeviewPlugin from './index';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function build(
  files: Record<string, string>,
  vibeview: unknown,
  extra: { options?: Record<string, unknown>; before?: Plugin[]; after?: Plugin[] } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-plugin-'));
  dirs.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), contents);
  }
  const stagingDir = path.join(root, 'out');
  const builder = new ProgramBuilder();
  for (const p of extra.before ?? []) builder.plugins.add(p);
  builder.plugins.add(vibeviewPlugin());
  for (const p of extra.after ?? []) builder.plugins.add(p);
  await builder.run({
    rootDir: root,
    stagingDir,
    retainStagingDir: true,
    createPackage: false,
    watch: false,
    files: ['manifest', 'components/**/*', 'source/**/*'],
    vibeview,
    ...extra.options,
  } as never);
  const read = (rel: string) =>
    fs.existsSync(path.join(stagingDir, rel))
      ? fs.readFileSync(path.join(stagingDir, rel), 'utf8')
      : null;
  return { read, diagnostics: builder.program!.getDiagnostics() };
}

const MANIFEST = 'title=t\nmajor_version=1\nminor_version=0\nbuild_version=1\n';
const MAIN = 'sub Main()\nend sub\n';
const NAV = `<?xml version="1.0" encoding="utf-8" ?>
<component name="NavItem" extends="Group">
  <interface><field id="isFocused" type="boolean" /></interface>
  <script type="text/brightscript" uri="NavItem.brs" />
  <children><Label id="label" /><Poster id="icon" vibeviewId="nav-icon" /></children>
</component>
`;
const NAV_BRS = 'sub init()\n    m.label = m.top.findNode("label")\nend sub\n';
const PLAIN = `<?xml version="1.0" encoding="utf-8" ?>
<component name="Plain" extends="Group">
  <script type="text/brightscript" uri="Plain.brs" />
</component>
`;
const PLAIN_BRS = 'sub init()\n    print "plain"\nend sub\n';
const project = {
  manifest: MANIFEST,
  'source/main.brs': MAIN,
  'components/NavItem.xml': NAV,
  'components/NavItem.brs': NAV_BRS,
  'components/Plain.xml': PLAIN,
  'components/Plain.brs': PLAIN_BRS,
};

describe('vibeview-bsc-plugin', () => {
  it('enabled: injects autoMark into init(), adds the helper tag, strips vibeviewId', async () => {
    const { read } = await build(project, { enabled: true, highlightFields: ['isFocused'] });
    expect(read('components/NavItem.brs')).toMatch(
      /sub init\(\)\s*vibeview_autoMark\(\{"NavItem":\{"field":"isFocused","ids":\[\["icon","nav-icon"\]\]\}\}\)/,
    );
    const navXml = read('components/NavItem.xml')!;
    expect(navXml).toContain('uri="pkg:/components/vibeview/vibeview.brs"');
    expect(navXml).not.toContain('vibeviewId');
    expect(read('components/vibeview/vibeview.brs')).toContain('sub vibeview_autoMark');
  });

  it('leaves components it does not mark untouched', async () => {
    const { read } = await build(project, { enabled: true });
    // bsc itself adds a bslib <script> import to every component XML it transpiles,
    // so the XML is re-serialized; it must carry nothing of ours.
    expect(read('components/Plain.xml')).not.toContain('vibeview');
    expect(read('components/Plain.brs')).toBe(PLAIN_BRS);
    expect(read('source/main.brs')).toBe(MAIN);
  });

  it('disabled: no autoMark, ids still stripped, no helper file when nothing calls it', async () => {
    const { read } = await build(project, { enabled: false });
    expect(read('components/NavItem.brs')).toBe(NAV_BRS);
    expect(read('components/NavItem.xml')).not.toContain('vibeviewId');
    expect(read('components/NavItem.xml')).not.toContain('vibeview.brs');
    expect(read('components/vibeview/vibeview.brs')).toBeNull();
  });

  it('disabled: a component calling the markup helpers gets the no-op helper and compiles', async () => {
    const files = {
      ...project,
      'components/Plain.brs': 'sub init()\n    vibeview_setHighlight(m.top, true)\nend sub\n',
    };
    const { read, diagnostics } = await build(files, { enabled: false });
    // Map to messages: a diagnostic holds its file (and so the whole program), which
    // vitest cannot diff without running out of memory.
    expect(diagnostics.filter((d) => d.severity === 1).map((d) => d.message)).toEqual([]);
    expect(read('components/Plain.xml')).toContain('uri="pkg:/components/vibeview/vibeview.brs"');
    const helper = read('components/vibeview/vibeview.brs')!;
    expect(helper).toContain('sub vibeview_setHighlight');
    expect(helper).not.toContain('vibeview_autoMark');
  });

  it('a component with no init() gets an inline init that calls autoMark', async () => {
    const files = {
      manifest: MANIFEST,
      'source/main.brs': MAIN,
      'components/Bare.xml': `<?xml version="1.0" encoding="utf-8" ?>
<component name="Bare" extends="Group">
  <interface><field id="isFocused" type="boolean" /></interface>
</component>
`,
    };
    const { read } = await build(files, { enabled: true, highlightFields: ['isFocused'] });
    const bare = read('components/Bare.xml')!;
    expect(bare).toMatch(
      /sub init\(\)\s*vibeview_autoMark\(\{"Bare":\{"field":"isFocused"\}\}\)\s*end sub/,
    );
    expect(bare).toContain('uri="pkg:/components/vibeview/vibeview.brs"');
  });

  it('VIBEVIEW_MARKERS=1 enables a config that says false', async () => {
    process.env.VIBEVIEW_MARKERS = '1';
    try {
      const { read } = await build(project, { enabled: false });
      expect(read('components/NavItem.brs')).toContain('vibeview_autoMark');
    } finally {
      delete process.env.VIBEVIEW_MARKERS;
    }
  });

  it('validates markup calls against the helper and never reports it unreferenced', async () => {
    const files = {
      ...project,
      'components/Plain.brs': 'sub init()\n    vibeview_setHighlight(m.top)\nend sub\n',
    };
    const { diagnostics } = await build(files, { enabled: true });
    const codes = diagnostics.map((d) => d.code);
    expect(codes).not.toContain(1013); // file not referenced
    expect(codes).not.toContain(1140); // cannot find function
    expect(codes).toContain(1002); // argument count mismatch: the real signature was checked
  });

  it('a child of a marked parent inherits the helper import and gets its own table', async () => {
    const files = {
      manifest: MANIFEST,
      'source/main.brs': MAIN,
      'components/Base.xml': `<?xml version="1.0" encoding="utf-8" ?>
<component name="Base" extends="Group">
  <interface><field id="isFocused" type="boolean" /></interface>
  <script type="text/brightscript" uri="Base.brs" />
</component>
`,
      'components/Base.brs': 'sub init()\n    m.base = true\nend sub\n',
      'components/Child.xml': `<?xml version="1.0" encoding="utf-8" ?>
<component name="Child" extends="Base">
  <script type="text/brightscript" uri="Child.brs" />
</component>
`,
      'components/Child.brs': 'sub init()\n    m.child = true\nend sub\n',
    };
    const { read } = await build(files, { enabled: true, highlightFields: ['isFocused'] });
    expect(read('components/Base.xml')).toContain('uri="pkg:/components/vibeview/vibeview.brs"');
    expect(read('components/Child.xml')).not.toContain('vibeview.brs');
    expect(read('components/Base.brs')).toContain(
      'vibeview_autoMark({"Base":{"field":"isFocused"}})',
    );
    expect(read('components/Child.brs')).toContain(
      'vibeview_autoMark({"Child":{"field":"isFocused"}})',
    );
  });

  it('re-emits an injected init() with its comments and statements intact, call first', async () => {
    const files = {
      ...project,
      'components/NavItem.brs':
        "' top\nsub init() ' header\n    ' body\n    m.a = 1 ' trailing\nend sub\n\nsub other()\n    m.b = 2\nend sub\n",
    };
    const { read } = await build(files, { enabled: true, highlightFields: ['isFocused'] });
    expect(read('components/NavItem.brs')).toBe(
      "' top\nsub init() ' header\n" +
        '    vibeview_autoMark({"NavItem":{"field":"isFocused","ids":[["icon","nav-icon"]]}})\n' +
        "    ' body\n    m.a = 1 ' trailing\nend sub\n\nsub other()\n    m.b = 2\nend sub",
    );
  });

  it("a hand-copied helper in the project is replaced by this build's helper", async () => {
    const files = {
      ...project,
      'components/vibeview/vibeview.brs':
        'sub vibeview_setHighlight(node as Object, on as Boolean)\nend sub\n',
    };
    const { read } = await build(files, { enabled: true });
    expect(read('components/vibeview/vibeview.brs')).toContain('sub vibeview_autoMark');
  });

  it('keeps a helper that a component imports by hand, even when nothing calls it', async () => {
    const files = {
      ...project,
      'components/Plain.xml': PLAIN.replace(
        '</component>',
        '  <script type="text/brightscript" uri="pkg:/components/vibeview/vibeview.brs" />\n</component>',
      ),
      'components/vibeview/vibeview.brs':
        'sub vibeview_setId(node as Object, id as String)\nend sub\n',
    };
    const { read, diagnostics } = await build(files, { enabled: false });
    expect(diagnostics.filter((d) => d.severity === 1).map((d) => d.message)).toEqual([]);
    expect(read('components/vibeview/vibeview.brs')).not.toContain('vibeview_autoMark');
    expect(read('components/vibeview/vibeview.brs')).toContain('sub vibeview_setHighlight');
  });

  const HELPER_TAG = 'uri="pkg:/components/vibeview/vibeview.brs"';

  it('an unmarked component sharing the marked init file also imports the helper', async () => {
    const files = {
      manifest: MANIFEST,
      'source/main.brs': MAIN,
      'components/A.xml': `<?xml version="1.0" encoding="utf-8" ?>
<component name="A" extends="Group">
  <interface><field id="isFocused" type="boolean" /></interface>
  <script type="text/brightscript" uri="shared.brs" />
</component>
`,
      'components/B.xml': `<?xml version="1.0" encoding="utf-8" ?>
<component name="B" extends="Group">
  <script type="text/brightscript" uri="shared.brs" />
</component>
`,
      'components/shared.brs': 'sub init()\n    m.x = 1\nend sub\n',
    };
    const { read } = await build(files, { enabled: true, highlightFields: ['isFocused'] });
    expect(read('components/shared.brs')).toContain('vibeview_autoMark({"A":');
    expect(read('components/A.xml')).toContain(HELPER_TAG);
    expect(read('components/B.xml')).toContain(HELPER_TAG);
  });

  it('an unmarked parent whose init a marked child inherits imports the helper', async () => {
    const files = {
      manifest: MANIFEST,
      'source/main.brs': MAIN,
      'components/Base.xml': `<?xml version="1.0" encoding="utf-8" ?>
<component name="Base" extends="Group">
  <script type="text/brightscript" uri="Base.brs" />
</component>
`,
      'components/Base.brs': 'sub init()\n    m.base = true\nend sub\n',
      'components/Derived.xml': `<?xml version="1.0" encoding="utf-8" ?>
<component name="Derived" extends="Base">
  <interface><field id="isFocused" type="boolean" /></interface>
</component>
`,
    };
    const { read } = await build(files, { enabled: true, highlightFields: ['isFocused'] });
    expect(read('components/Base.brs')).toContain('vibeview_autoMark({"Derived":');
    // Every plain Base instance runs that init too, so Base carries the import; Derived inherits it.
    expect(read('components/Base.xml')).toContain(HELPER_TAG);
    expect(read('components/Derived.xml')).not.toContain('vibeview.brs');
  });

  it('validate: false still strips ids, injects, and imports the helper where it is called', async () => {
    const files = {
      ...project,
      'components/Plain.brs': 'sub init()\n    vibeview_setId(m.top, "plain")\nend sub\n',
    };
    const enabled = await build(files, { enabled: true }, { options: { validate: false } });
    expect(enabled.read('components/NavItem.brs')).toContain('vibeview_autoMark');
    expect(enabled.read('components/NavItem.xml')).toContain(HELPER_TAG);
    expect(enabled.read('components/NavItem.xml')).not.toContain('vibeviewId');
    expect(enabled.read('components/Plain.xml')).toContain(HELPER_TAG);

    const store = await build(project, { enabled: false }, { options: { validate: false } });
    expect(store.read('components/NavItem.xml')).not.toContain('vibeviewId');
    expect(store.read('components/vibeview/vibeview.brs')).toBeNull();
  });

  for (const hook of ['beforeProgramValidate', 'beforeProgramTranspile'] as const) {
    it(`another plugin dropping the dependency edge (${hook}) cannot ship autoMark without the import`, async () => {
      // Re-setting the XML replaces its dependency-graph node, dropping our edge.
      const resetter: Plugin = {
        name: 'resetter',
        [hook](program: Program) {
          const f = program.getFile('components/NavItem.xml')!;
          program.setFile({ src: f.srcPath, dest: f.pkgPath }, f.fileContents);
        },
      };
      const { read } = await build(project, { enabled: true }, { after: [resetter] });
      expect(read('components/NavItem.brs')).toContain('vibeview_autoMark');
      const nav = read('components/NavItem.xml')!;
      expect(nav.split('vibeview/vibeview.brs').length - 1).toBe(1);
    });
  }

  const breaker: Plugin = {
    name: 'breaker',
    afterProgramCreate(program: Program) {
      const graph = (
        program as unknown as {
          dependencyGraph: { addDependency: (key: string, dep: string) => void };
        }
      ).dependencyGraph;
      const add = graph.addDependency.bind(graph);
      graph.addDependency = (key: string, dep: string) => {
        if (dep === 'components/vibeview/vibeview.brs') throw new Error('boom');
        return add(key, dep);
      };
    },
  };
  const callerProject = {
    ...project,
    'components/Plain.brs': 'sub init()\n    vibeview_setId(m.top, "plain")\nend sub\n',
  };
  const errorsOf = (diagnostics: { severity?: number; message: unknown }[]) =>
    diagnostics.filter((d) => d.severity === 1).map((d) => String(d.message));

  it('if the helper cannot be wired in, a validated build fails with an error', async () => {
    const { read, diagnostics } = await build(
      callerProject,
      { enabled: true },
      { before: [breaker] },
    );
    expect(errorsOf(diagnostics).some((m) => m.startsWith('vibeview:') && m.includes('boom'))).toBe(
      true,
    );
    expect(read('components/NavItem.brs')).toBeNull(); // bsc stops before staging
  });

  it('if the helper cannot be wired in (validate: false), no markers ship and callers keep the import', async () => {
    const { read, diagnostics } = await build(
      callerProject,
      { enabled: true },
      { before: [breaker], options: { validate: false } },
    );
    expect(errorsOf(diagnostics).some((m) => m.includes('boom'))).toBe(true);
    expect(read('components/NavItem.brs')).toBe(NAV_BRS);
    expect(read('components/NavItem.xml')).not.toContain('vibeviewId');
    expect(read('components/Plain.xml')).toContain(HELPER_TAG);
  });

  it('enabled build writes the configured id/label lists into the helper', async () => {
    const { read } = await build(project, {
      enabled: true,
      idFields: ['itemContent._id', 'id'],
      labelFields: ['itemContent.title'],
    });
    expect(read('components/vibeview/vibeview.brs')).toContain(
      'return {ids: ["itemContent._id", "id"], labels: ["itemContent.title"]}',
    );
  });
});
