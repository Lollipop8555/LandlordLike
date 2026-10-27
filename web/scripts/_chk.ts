import { EFFECTS_BY_SYMBOL, ITEMS } from '../src/data';
import { rulesOf } from '../src/effects';

for (const id of ['horseshoe', 'pool_ball', 'four_leaf_clover', 'ritual_candle', 'happy_hour']) {
  const s = ITEMS.find((i) => i.id === id);
  console.log(id, 'effectsInDef=', s?.effects.length, 'bySymbol=', EFFECTS_BY_SYMBOL.get(id)?.length, 'rulesOf=', rulesOf(id).length);
}
console.log('item rules total', ITEMS.reduce((a, i) => a + i.effects.length, 0));
console.log('bySymbol keys', EFFECTS_BY_SYMBOL.size);
