// Private authoring metadata is read locally, never bundled into the PWA.
export function validateIdAliases(value, baselineIds) {
  const fail = () => { throw new Error('ID互換性台帳が不正です。'); };
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
  if (!exact(value, ['version', 'aliases']) || value.version !== 1 || !Array.isArray(value.aliases)) fail();
  const map = new Map();
  const targets = new Set();
  const id = /^nw-[a-f0-9]{24}$/;
  for (const row of value.aliases) {
    if (!exact(row, ['currentId', 'legacyId', 'reason'])
      || !id.test(row.currentId) || !id.test(row.legacyId)
      || row.currentId === row.legacyId || !baselineIds.has(row.legacyId)
      || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 2000
      || map.has(row.currentId) || targets.has(row.legacyId)) fail();
    map.set(row.currentId, row.legacyId);
    targets.add(row.legacyId);
  }
  if ([...targets].some(target => map.has(target))) fail();
  return map;
}

export function resolveIdAliases(cards, aliases) {
  const present = new Set(cards.map(card => card.id));
  if ([...aliases.keys()].some(id => !present.has(id))) throw new Error('ID互換性台帳の参照先がありません。');
  const resolved = cards.map(card => ({ ...card, id: aliases.get(card.id) ?? card.id }));
  if (new Set(resolved.map(card => card.id)).size !== resolved.length) throw new Error('ID互換性台帳に重複があります。');
  return resolved;
}

export function partitionIdAliases(aliases, baseline) {
  const textbook = new Set(baseline.textbookIds);
  const catchup = new Set(baseline.catchupIds);
  if ([...textbook].some(id => catchup.has(id))) throw new Error('ID互換性台帳のコレクションが不一致です。');
  return {
    textbook: new Map([...aliases].filter(([, id]) => textbook.has(id))),
    catchup: new Map([...aliases].filter(([, id]) => catchup.has(id))),
  };
}
