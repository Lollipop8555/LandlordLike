/**
 * 一次性道具的文字说明。
 *
 * 这批道具的效果发生在「买下的瞬间」（Item__Item.gd:426-520 的 match type 分支），
 * 不是「持有期间」的持续声明，所以 item_effects.csv 里没有它们的行，
 * 自动渲染只会显示「无特效」。实际结算见 engine.ts 的 applyItemOnBuy。
 *
 * 数值与 items.csv 的 values 保持一致；改数值时两处都要改。
 */
export const ITEM_NOTES: Record<string, string> = {
  barrel_o_dwarves: '买下时，立刻往棋盘加入 7 个矮人',
  goldilocks: '买下时，立刻往棋盘加入 3 只熊',
  lunchbox: '买下时，立刻往棋盘加入 3 个食物类符号',
  adoption_papers: '买下时，立刻往棋盘加入 3 个动物类符号',
  symbol_bomb_quantum: '买下时，立刻往棋盘加入 5 个「已通过」类符号',
  symbol_bomb_small: '买下时，立刻往棋盘加入 2 个随机符号',
  symbol_bomb_big: '买下时，立刻往棋盘加入 4 个随机符号',
  symbol_bomb_very_big: '买下时，立刻往棋盘加入 8 个随机符号',
  booster_pack: '买下时，加入 4 个相同的普通符号、3 个相同的罕见符号、1 个稀有符号',
  coffee: '买下时，本期旋转次数 +1',
  // 不是一次性效果，但同样没有声明：结算在 engine.ts 的符号移除阶段
  lint_roller: '每个被吃掉的兔毛，让本道具的数值 +10（数值算进道具相关的加成）',
  // 每转触发一次，挂在「停盘之后、结算之前」的窗口里（Pop-up__Pop-up.gd:2638）
  swapping_device: '每转开始时，你可以交换棋盘上两个符号的位置（每转只能换一次，也可以不换）',
  // 被摧毁的盒子符号有 50% 概率原样补回棋盘，最多补 7 次（Item__Item.gd:2335）
  mobius_strip: '盒子组符号被摧毁时，50% 概率把它原样补回棋盘；累积补满 7 次后不再触发',
  // 每层祭坛各产一个灵魂（Item__Item.gd:1957，`for i in item_count`）
  shrine: '生物组符号被摧毁时，每层祭坛生成 1 个灵魂',
};
