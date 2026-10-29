// 原版行为尚未还原的符号：保留在牌库/图鉴里可查，但不进商店抽取池。
//
// 判定依据不是"效果声明少"，而是"有行为证据、但抽取链路把语句丢了"。
// 上一批 12 张（goose / cow / bartender / beehive / tomb / oyster / hex_of_midas /
// pinata / urn / big_urn / big_ore / coconut）就属于这种情况：它们的专属行为是
// `tiles_to_add`（生成另一个符号），而这句声明以前整段被丢掉，只剩概率参数，
// 于是每转只是"什么都没发生"。现在抽取管线把 `tiles_to_add` 解析成 `spawn`，
// 由引擎在旋转里 add_tile 到空格（见 `effects.ts` 的 ResolvedSpawn 与
// `engine.ts` 的 drainSpawns），这批符号已全部移出清单。
//
// 反例（不列入，属正常设计）：
//   · ore / banana / beer —— 没有参数、没有专属事件，是被别人引用的纯价值符号；
//   · `mobius_strip`、`frying_pan` —— 名字像符号，其实是道具，且煎锅的效果
//     由 effects.csv 里的 `*global*` 规则（蛋被摧毁时结算）兑现，不是空壳。
//
// `analysis/preflight.ts` 会核对清单与实现是否一致（清单里的符号必须仍然零生效
// 声明，且不得残留在抽取池里）；再出现同类问题时往这里加回来即可。

export const UNIMPLEMENTED_SYMBOLS: ReadonlySet<string> = new Set<string>([]);

export function isUnimplemented(id: string): boolean {
  return UNIMPLEMENTED_SYMBOLS.has(id);
}

// 还没还原效果的道具：既没有自身声明（`item_effects.csv` 零行），也没有被别的符号
// 当作前置条件引用，买下来只是一件带数值的持有物。清单来源是逐条比对源码后确认
// 「行为不在 add_conditional_effects 里，也不在 Item__Item.gd 的 match type 分支里」。
// 从这份清单里拿掉一项的前提是真的实现了效果，并同步补上描述。
export const UNIMPLEMENTED_ITEMS: ReadonlySet<string> = new Set<string>([
  'ancient_lizard_blade',
  'capsule_machine',
  'checkered_flag',
  'clear_sky',
  'comfy_pillow',
  'copycat',
  'cursed_katana',
  'gray_pepper',
  'item_missing',
  'lime_pepper',
  'pink_pepper',
  'popsicle',
  'quiver',
  'time_machine',
]);

export function isItemUnimplemented(id: string): boolean {
  return UNIMPLEMENTED_ITEMS.has(id);
}
