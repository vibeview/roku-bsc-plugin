import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { util } from 'brighterscript';
import { runInit } from './init';

let dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-init-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const NATIVE = {
  enabled: false,
  highlightFields: ['itemHasFocus'],
  idFields: ['itemContent.id'],
  labelFields: ['itemContent.title'],
};

describe('init', () => {
  it('creates bsconfig.json with the plugin and the native lists', () => {
    const dir = tmp();
    const r = runInit(dir);
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'bsconfig.json'), 'utf8'))).toEqual({
      plugins: ['@vibeview/roku-bsc-plugin'],
      vibeview: NATIVE,
    });
  });

  it('adds to an existing file, keeping its content and comments', () => {
    const dir = tmp();
    const file = path.join(dir, 'bsconfig.json');
    fs.writeFileSync(
      file,
      '{\n  // keep me\n  "rootDir": ".",\n  "plugins": ["other-plugin"], /* and me */\n  "files": ["source/**/*",],\n}\n',
    );
    expect(runInit(dir).ok).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('// keep me');
    expect(text).toContain('/* and me */');
    expect(text).toContain('"rootDir": "."');
    expect(text).toContain('"other-plugin"');
    expect(text).toContain('"@vibeview/roku-bsc-plugin"');
    expect(text).toContain('"itemHasFocus"');
  });

  it('does not list the plugin twice (path references count)', () => {
    const dir = tmp();
    const file = path.join(dir, 'bsconfig.json');
    fs.writeFileSync(file, '{"plugins": ["../../roku-bsc-plugin/dist/index.js"]}');
    runInit(dir);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(json.plugins).toHaveLength(1);
    expect(json.vibeview).toEqual(NATIVE);
  });

  it('does not mistake an unrelated plugin with a similar name for this one', () => {
    const dir = tmp();
    const file = path.join(dir, 'bsconfig.json');
    fs.writeFileSync(file, '{"plugins": ["@x/roku-bsc-plugin-foo"]}');
    runInit(dir);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(json.plugins).toEqual(['@x/roku-bsc-plugin-foo', '@vibeview/roku-bsc-plugin']);
  });

  it('recognises the package by name, scoped or under node_modules', () => {
    for (const entry of [
      '@vibeview/roku-bsc-plugin',
      './node_modules/@vibeview/roku-bsc-plugin/dist/index.js',
      'node_modules/@vibeview/roku-bsc-plugin',
    ]) {
      const dir = tmp();
      const file = path.join(dir, 'bsconfig.json');
      fs.writeFileSync(file, JSON.stringify({ plugins: [entry] }));
      runInit(dir);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).plugins).toEqual([entry]);
    }
  });

  it('refuses to overwrite an existing vibeview block without --force, changing nothing', () => {
    const dir = tmp();
    const file = path.join(dir, 'bsconfig.json');
    const before = '{"vibeview": {"enabled": true, "highlightFields": ["isFocused"]}}';
    fs.writeFileSync(file, before);
    const r = runInit(dir);
    expect(r.ok).toBe(false);
    expect(r.messages.join('\n')).toContain('--force');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('--force replaces the block', () => {
    const dir = tmp();
    const file = path.join(dir, 'bsconfig.json');
    fs.writeFileSync(file, '{"vibeview": {"enabled": true, "highlightFields": ["isFocused"]}}');
    expect(runInit(dir, { force: true }).ok).toBe(true);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(json.vibeview).toEqual(NATIVE);
    expect(json.plugins).toEqual(['@vibeview/roku-bsc-plugin']);
  });

  it('refuses an unparseable file', () => {
    const dir = tmp();
    const file = path.join(dir, 'bsconfig.json');
    fs.writeFileSync(file, '{ not json');
    expect(runInit(dir).ok).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });

  describe('a bsconfig that extends another', () => {
    // bsc merges `extends` shallowly: a `plugins` or `vibeview` the child writes replaces
    // the base's whole value. Check what bsc itself ends up with.
    const effective = (dir: string) =>
      util.loadConfigFile(path.join(dir, 'bsconfig.json')) as {
        plugins?: string[];
        vibeview?: unknown;
      };
    const write = (dir: string, rel: string, json: unknown) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), JSON.stringify(json, null, 2));
    };

    it("keeps the base's plugins and leaves the base's vibeview block in charge", () => {
      const dir = tmp();
      const block = { highlightFields: ['isFocused', 'itemHasFocus'] };
      write(dir, 'bsconfig.base.json', { plugins: ['@rokucommunity/bslint'], vibeview: block });
      write(dir, 'bsconfig.json', { extends: './bsconfig.base.json' });
      const r = runInit(dir);
      expect(r.ok).toBe(true);
      const cfg = effective(dir);
      expect(cfg.plugins).toEqual(['@rokucommunity/bslint', '@vibeview/roku-bsc-plugin']);
      expect(cfg.vibeview).toEqual(block);
      expect(r.messages.join('\n')).toContain('bsconfig.base.json');
    });

    it('does not list the plugin again when the base lists it', () => {
      const dir = tmp();
      write(dir, 'bsconfig.base.json', { plugins: ['@vibeview/roku-bsc-plugin'] });
      write(dir, 'bsconfig.json', { extends: './bsconfig.base.json', rootDir: '.' });
      expect(runInit(dir).ok).toBe(true);
      const local = JSON.parse(fs.readFileSync(path.join(dir, 'bsconfig.json'), 'utf8'));
      expect(local.plugins).toBeUndefined();
      expect(local.vibeview).toEqual(NATIVE);
      expect(effective(dir).plugins).toEqual(['@vibeview/roku-bsc-plugin']);
    });

    it("rebases a base's relative plugin paths, through a chain of extends", () => {
      const dir = tmp();
      write(dir, 'config/base.json', { plugins: ['./plugins/x.js'] });
      write(dir, 'config/mid.json', { extends: './base.json' });
      write(dir, 'bsconfig.json', { extends: './config/mid.json' });
      expect(runInit(dir).ok).toBe(true);
      const local = JSON.parse(fs.readFileSync(path.join(dir, 'bsconfig.json'), 'utf8'));
      expect(local.plugins).toEqual(['./config/plugins/x.js', '@vibeview/roku-bsc-plugin']);
      expect(effective(dir).plugins).toEqual([
        path.join(dir, 'config/plugins/x.js'),
        '@vibeview/roku-bsc-plugin',
      ]);
    });

    it('--force writes a local vibeview block over the inherited one', () => {
      const dir = tmp();
      write(dir, 'base.json', { vibeview: { enabled: true } });
      write(dir, 'bsconfig.json', { extends: './base.json' });
      expect(runInit(dir, { force: true }).ok).toBe(true);
      expect(effective(dir).vibeview).toEqual(NATIVE);
    });

    it('refuses when the base file cannot be read, changing nothing', () => {
      const dir = tmp();
      const before = '{"extends": "./missing.json"}';
      fs.writeFileSync(path.join(dir, 'bsconfig.json'), before);
      expect(runInit(dir).ok).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'bsconfig.json'), 'utf8')).toBe(before);
    });
  });
});
