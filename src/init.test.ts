import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
      plugins: ['vibeview-bsc-plugin'],
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
    expect(text).toContain('"vibeview-bsc-plugin"');
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
    expect(json.plugins).toEqual(['@x/roku-bsc-plugin-foo', 'vibeview-bsc-plugin']);
  });

  it('recognises the package by name, scoped or under node_modules', () => {
    for (const entry of [
      'vibeview-bsc-plugin',
      './node_modules/vibeview-bsc-plugin/dist/index.js',
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
    expect(json.plugins).toEqual(['vibeview-bsc-plugin']);
  });

  it('refuses an unparseable file', () => {
    const dir = tmp();
    const file = path.join(dir, 'bsconfig.json');
    fs.writeFileSync(file, '{ not json');
    expect(runInit(dir).ok).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });
});
