import { describe, expect, it } from 'vitest';
import { validateIdAliases, resolveIdAliases, partitionIdAliases } from '../scripts/id-aliases.mjs';

describe('private identity correction metadata', () => {
  const current = 'nw-' + 'a'.repeat(24), legacy = 'nw-' + 'b'.repeat(24);
  const value = { version: 1, aliases: [{ currentId: current, legacyId: legacy, reason: 'synthetic correction' }] };
  it('retains the published id while changing display content without mutating input', () => {
    const cards = [{ id: current, term: 'corrected display', order: 4 }];
    const aliases = validateIdAliases(value, new Set([legacy]));
    expect(resolveIdAliases(cards, aliases)).toEqual([{ ...cards[0], id: legacy }]);
    expect(cards[0].id).toBe(current);
  });
  it('rejects missing and duplicate targets, unknown fields, malformed values and chains', () => {
    for (const invalid of [null, { ...value, extra: true }, { ...value, version: true },
      { ...value, aliases: [...value.aliases, ...value.aliases] },
      { ...value, aliases: [{ ...value.aliases[0], reason: '' }] },
      { ...value, aliases: [{ ...value.aliases[0], currentId: legacy }] },
      { ...value, aliases: [{ ...value.aliases[0], legacyId: 'nw-' + 'c'.repeat(24) }] },
      { ...value, aliases: [...value.aliases, { currentId: legacy, legacyId: current, reason: 'cycle' }] },
    ]) expect(() => validateIdAliases(invalid, new Set([legacy, current]))).toThrow('ID互換性台帳');
    const aliases = validateIdAliases(value, new Set([legacy]));
    expect(() => resolveIdAliases([], aliases)).toThrow('参照先');
    expect(() => resolveIdAliases([{id: current}, {id: legacy}], aliases)).toThrow('重複');
  });
  it('preserves catchup identity independently and rejects a cross-collection correction', () => {
    const aliases = validateIdAliases(value, new Set([legacy]));
    const scoped = partitionIdAliases(aliases, { textbookIds: [], catchupIds: [legacy] });
    expect(resolveIdAliases([], scoped.textbook)).toEqual([]);
    expect(resolveIdAliases([{id: current}], scoped.catchup)).toEqual([{id: legacy}]);
    expect(() => resolveIdAliases([], scoped.catchup)).toThrow('参照先');
    expect(() => partitionIdAliases(aliases, {textbookIds:[legacy], catchupIds:[legacy]})).toThrow('コレクション');
  });
});
