import { describe, expect, it } from 'vitest';
import {
  hasEntry,
  NATIVE_HIGHLIGHT_FIELDS,
  NATIVE_ID_FIELDS,
  NATIVE_LABEL_FIELDS,
  resolveConfig,
} from './config';

describe('resolveConfig', () => {
  it('defaults to disabled with only the native list-item fields', () => {
    expect(resolveConfig(undefined, {})).toEqual({
      enabled: false,
      highlightFields: ['itemHasFocus'],
      components: {},
      idFields: ['itemContent.id'],
      labelFields: ['itemContent.title'],
    });
    expect(NATIVE_HIGHLIGHT_FIELDS).toEqual(['itemHasFocus']);
    expect(NATIVE_ID_FIELDS).toEqual(['itemContent.id']);
    expect(NATIVE_LABEL_FIELDS).toEqual(['itemContent.title']);
  });
  it('reads enabled, ordered fields and per-component overrides', () => {
    expect(
      resolveConfig(
        {
          enabled: true,
          highlightFields: ['isFocused', 'focused'],
          components: { SearchBar: false, Avatar: 'isActive' },
        },
        {},
      ),
    ).toEqual({
      enabled: true,
      highlightFields: ['isFocused', 'focused'],
      components: { SearchBar: false, Avatar: 'isActive' },
      idFields: ['itemContent.id'],
      labelFields: ['itemContent.title'],
    });
  });
  it('VIBEVIEW_MARKERS=1 enables a config that says false', () => {
    expect(resolveConfig({ enabled: false }, { VIBEVIEW_MARKERS: '1' }).enabled).toBe(true);
  });
  it('ignores malformed values instead of throwing', () => {
    expect(
      resolveConfig({ enabled: 'yes', highlightFields: 'isFocused', components: [1] }, {}),
    ).toEqual({
      enabled: false,
      highlightFields: ['itemHasFocus'],
      components: {},
      idFields: ['itemContent.id'],
      labelFields: ['itemContent.title'],
    });
  });
  it('drops non-string field names and bad override values', () => {
    expect(
      resolveConfig({ highlightFields: ['focused', 3], components: { A: 1, B: 'x' } }, {}),
    ).toEqual({
      enabled: false,
      highlightFields: ['focused'],
      components: { B: 'x' },
      idFields: ['itemContent.id'],
      labelFields: ['itemContent.title'],
    });
  });
  it('uses the idFields and labelFields exactly as written', () => {
    expect(
      resolveConfig(
        { idFields: ['itemContent._id', 'id', 4], labelFields: ['itemContent.name', ''] },
        {},
      ),
    ).toMatchObject({
      idFields: ['itemContent._id', 'id'],
      labelFields: ['itemContent.name'],
    });
  });
  it('drops paths deeper than two levels', () => {
    expect(resolveConfig({ idFields: ['a.b.c', 'a.b'] }, {}).idFields).toEqual(['a.b']);
  });
  it('a key that is absent, not an array or empty falls back to the native list', () => {
    for (const raw of [{}, { highlightFields: [], idFields: 'x', labelFields: [3, ''] }]) {
      expect(resolveConfig(raw, {})).toMatchObject({
        highlightFields: ['itemHasFocus'],
        idFields: ['itemContent.id'],
        labelFields: ['itemContent.title'],
      });
    }
  });
  it('a written list is used verbatim: natives are not appended', () => {
    const c = resolveConfig(
      { highlightFields: ['highlighted', 'isFocused'], idFields: ['id'], labelFields: ['name'] },
      {},
    );
    expect(c.highlightFields).toEqual(['highlighted', 'isFocused']);
    expect(c.idFields).toEqual(['id']);
    expect(c.labelFields).toEqual(['name']);
  });
  it('hasEntry compares ignoring case', () => {
    expect(hasEntry(['ITEMHASFOCUS'], 'itemHasFocus')).toBe(true);
    expect(hasEntry(['isFocused'], 'itemHasFocus')).toBe(false);
  });
  it('components: false stays the opt-out', () => {
    expect(resolveConfig({ components: { Poster: false } }, {}).components).toEqual({
      Poster: false,
    });
  });
});
