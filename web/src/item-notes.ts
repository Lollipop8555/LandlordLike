/**
 * 道具的玩家向说明：一条规则 =「触发条件」+「效果」。
 *
 * 为什么不复用 `describeRule`：那套生成器是给棋盘符号写的——主语是「本符号」、
 * 条件是「相邻的 X」、数值槽位取自符号自己的 values。道具不占格、作用于全场，
 * 套用后就会冒出「本符号数值变为被摧毁符号的对应数值」这类读不懂的句子。
 *
 * 数值不写死：所有数字都从 items.csv（→ items.json）的 values 取，
 * 改数值时只需要改一处。
 */
import { ITEM_BY_ID } from './data';

export interface ItemLine {
  /** 触发时机 / 前提条件 */
  when: string;
  /** 满足条件后发生什么 */
  effect: string;
}

export interface ItemDesc {
  /** 一句话概括 */
  summary: string;
  lines: ItemLine[];
  /**
   * 效果只改「道具自身的价值」，不影响棋盘产出。
   * 引擎里 held.value 只用于道具面板显示，不进入 boardTotal，
   * 这类道具需要统一提示一句，否则玩家会以为自己在亏。
   */
  selfValueOnly?: boolean;
  /** 逐条的实现差异说明，没有就不写 */
  gap?: string;
}

type Builder = (v: number[]) => ItemDesc;

/** 自身价值类道具的统一提示（渲染层用） */
export const SELF_VALUE_NOTE =
  '道具自身价值只体现在道具面板上，不参与棋盘每转产出。';

/** values[i] 的字面量；缺值时给 fallback，避免文案里出现 undefined */
function n(v: number[], i: number, fallback = 0): string {
  const x = v[i];
  if (typeof x !== 'number') return String(fallback);
  return String(Number.isInteger(x) ? x : Number(x.toFixed(2)));
}

/** 加算型规则按「持有层数」线性放大 */
const STACK_SUM = '，每持有一层再叠一次';
/** 倍率型规则按「持有层数」幂放大 */
const STACK_POW = '，每持有一层再乘一次';

/** 买下瞬间生效的道具共用同一句时机 */
const ON_BUY = '买下的瞬间（只触发一次）';
/** 每转结算时的共同时机 */
const EACH_SPIN = '每转结算时';

/**
 * 「没有任何可执行效果」的道具统一说法。
 * 不要写「未实现 / 未还原」——那是开发者视角的完成度标签，
 * 玩家只关心「买了会不会有变化」。
 */
const TODO_GAP = '这件道具的玩法还没有接入，买下后不会改变场面。';

/** 彩色胡椒共用的规则：被触发过一次就把自身价值定为第一个数值 */
function pepperSelf(v: number[]): ItemDesc {
  return {
    summary: '被其他符号触发后提高自身价值',
    lines: [{ when: '本符号已被其他符号触发过时', effect: `道具自身价值变为 ${n(v, 0)}` }],
    selfValueOnly: true,
  };
}

function todo(gap = TODO_GAP): ItemDesc {
  return { summary: '暂无效果', lines: [], gap };
}

const DESC: Record<string, Builder> = {
  /* ── 买下即用：往棋盘塞符号 ── */
  adoption_papers: (v) => ({
    summary: '一次性：生成一批动物符号',
    lines: [
      {
        when: ON_BUY,
        effect: `随机挑一种动物类符号，往棋盘空格放入 ${n(v, 0)} 个；棋盘放满就停`,
      },
    ],
  }),
  barrel_o_dwarves: (v) => ({
    summary: '一次性：生成一批矮人',
    lines: [{ when: ON_BUY, effect: `往棋盘空格放入 ${n(v, 0)} 个矮人；棋盘放满就停` }],
  }),
  goldilocks: (v) => ({
    summary: '一次性：生成一批熊',
    lines: [{ when: ON_BUY, effect: `往棋盘空格放入 ${n(v, 0)} 个熊；棋盘放满就停` }],
  }),
  lunchbox: (v) => ({
    summary: '一次性：生成一批食物符号',
    lines: [
      {
        when: ON_BUY,
        effect: `随机挑一种食物类符号，往棋盘空格放入 ${n(v, 0)} 个；棋盘放满就停`,
      },
    ],
  }),
  symbol_bomb_small: (v) => ({
    summary: '一次性：生成随机符号',
    lines: [{ when: ON_BUY, effect: `按当前稀有度权重抽 ${n(v, 0)} 个随机符号放进棋盘空格` }],
  }),
  symbol_bomb_big: (v) => ({
    summary: '一次性：生成随机符号',
    lines: [{ when: ON_BUY, effect: `按当前稀有度权重抽 ${n(v, 0)} 个随机符号放进棋盘空格` }],
  }),
  symbol_bomb_very_big: (v) => ({
    summary: '一次性：生成随机符号',
    lines: [{ when: ON_BUY, effect: `按当前稀有度权重抽 ${n(v, 0)} 个随机符号放进棋盘空格` }],
  }),
  symbol_bomb_quantum: (v) => ({
    summary: '一次性：复制本转留在盘上的符号',
    lines: [
      {
        when: ON_BUY,
        effect: `从「本转结算后仍留在盘上」的符号里随机复制 ${n(v, 0)} 个，放进棋盘空格`,
      },
    ],
  }),
  booster_pack: (v) => ({
    summary: '一次性：按三档各生成一批同种符号',
    lines: [
      {
        when: ON_BUY,
        effect: `普通、罕见、稀有各随机抽一种，分别放入 ${n(v, 0)}、${n(v, 1)}、${n(v, 2)} 个；同一档内的多个副本是同一种符号`,
      },
    ],
  }),
  coffee: () => ({
    summary: '一次性：本期多转一次',
    lines: [{ when: ON_BUY, effect: '本期的可用旋转次数 +1' }],
  }),

  /* ── 每转强化某一类符号 ── */
  anthropology_degree: (v) => ({
    summary: '提高所有人形符号的数值',
    lines: [
      { when: EACH_SPIN, effect: `场上每个人类类符号数值 +${n(v, 0)}${STACK_SUM}` },
    ],
  }),
  birdhouse: (v) => ({
    summary: '提高所有鸟类符号的数值',
    lines: [{ when: EACH_SPIN, effect: `场上每个鸟类符号数值 +${n(v, 0)}${STACK_SUM}` }],
  }),
  cleaning_rag: (v) => ({
    summary: '提高所有宝石类符号的数值',
    lines: [{ when: EACH_SPIN, effect: `场上每个宝石类符号数值 +${n(v, 0)}${STACK_SUM}` }],
  }),
  fruit_basket: (v) => ({
    summary: '提高所有水果类符号的数值',
    lines: [{ when: EACH_SPIN, effect: `场上每个水果类符号数值 +${n(v, 0)}${STACK_SUM}` }],
  }),
  happy_hour: (v) => ({
    summary: '提高所有酒类符号的数值',
    lines: [{ when: EACH_SPIN, effect: `场上每个酒类符号数值 +${n(v, 0)}${STACK_SUM}` }],
  }),
  kyle_the_kernite: (v) => ({
    summary: '提高所有凯尔类符号的数值',
    lines: [{ when: EACH_SPIN, effect: `场上每个凯尔类符号数值 +${n(v, 0)}${STACK_SUM}` }],
  }),
  pizza_the_cat: (v) => ({
    summary: '提高所有猫的数值',
    lines: [{ when: EACH_SPIN, effect: `场上每个猫数值 +${n(v, 0)}${STACK_SUM}` }],
  }),
  nori_the_rabbit: (v) => ({
    summary: '提高兔子与兔毛的数值',
    lines: [
      { when: EACH_SPIN, effect: `场上每个兔子数值 +${n(v, 0)}${STACK_SUM}` },
      { when: EACH_SPIN, effect: `场上每个兔毛数值 +${n(v, 0)}${STACK_SUM}` },
    ],
  }),
  ricky_the_banana: (v) => ({
    summary: '提高香蕉与香蕉皮的数值',
    lines: [
      { when: EACH_SPIN, effect: `场上每个香蕉数值 +${n(v, 0)}${STACK_SUM}` },
      { when: EACH_SPIN, effect: `场上每个香蕉皮数值 +${n(v, 0)}${STACK_SUM}` },
    ],
  }),
  quigley_the_wolf: (v) => ({
    summary: '提高狼产出，并将狗变成狼',
    lines: [
      { when: EACH_SPIN, effect: `场上每个狼数值 +${n(v, 0)}${STACK_SUM}` },
      { when: EACH_SPIN, effect: '场上每个狗直接变成狼' },
    ],
  }),
  ritual_candle: (v) => ({
    summary: '提高所有咒符的数值',
    lines: [{ when: EACH_SPIN, effect: `场上每个咒符类符号数值 +${n(v, 0)}${STACK_SUM}` }],
  }),
  holy_water: (v) => ({
    summary: '提高咒符产出，并屏蔽咒符的副作用',
    lines: [
      { when: EACH_SPIN, effect: `场上每个咒符类符号数值 +${n(v, 0)}${STACK_SUM}` },
      {
        when: '乏味 / 盗窃 / 汲取 / 迈达斯咒符本应结算时',
        effect: '它们的自身规则不再生效（避免变稀有、扣数值、被吸干、刷金币）',
      },
    ],
  }),
  rain_cloud: (v) => ({
    summary: '提高雨产出，并将雨改回普通稀有度',
    lines: [
      { when: EACH_SPIN, effect: `场上每个雨数值 +${n(v, 0)}${STACK_SUM}` },
      {
        when: EACH_SPIN,
        effect: '场上每个雨的稀有度改为「普通」，商店抽取时按普通档计权',
      },
    ],
  }),
  maxwell_the_bear: (v) => ({
    summary: '提高所有熊的倍率',
    lines: [{ when: EACH_SPIN, effect: `场上每个熊的本轮倍率 ×${n(v, 0)}${STACK_POW}` }],
  }),
  oswald_the_monkey: (v) => ({
    summary: '提高所有猴子的倍率',
    lines: [{ when: EACH_SPIN, effect: `场上每个猴子的本轮倍率 ×${n(v, 0)}${STACK_POW}` }],
  }),
  dwarven_anvil: (v) => ({
    summary: '提高矮人倍率；矮人摧毁相邻的矿工亲和符号',
    lines: [
      { when: EACH_SPIN, effect: `场上每个矮人的本轮倍率 ×${n(v, 0)}${STACK_POW}` },
      {
        when: '持有矮人铁砧精华，且该矮人本转还没行动过',
        effect:
          '该矮人摧毁相邻的矿工亲和类符号，并把被摧毁符号的数值加到自己身上；每次结算消耗 1 个矮人铁砧精华',
      },
    ],
  }),
  triple_coins: (v) => ({
    summary: '提高所有金币的倍率',
    lines: [{ when: EACH_SPIN, effect: `场上每个金币的本轮倍率 ×${n(v, 0)}${STACK_POW}` }],
  }),
  jackolantern: (v) => ({
    summary: '提高所有万圣节符号的倍率',
    lines: [{ when: EACH_SPIN, effect: `场上每个万圣类符号的本轮倍率 ×${n(v, 0)}${STACK_POW}` }],
  }),
  blue_suits: (v) => ({
    summary: '提高梅花与黑桃的倍率',
    lines: [
      { when: EACH_SPIN, effect: `场上每个梅花的本轮倍率 ×${n(v, 0)}${STACK_POW}` },
      { when: EACH_SPIN, effect: `场上每个黑桃的本轮倍率 ×${n(v, 0)}${STACK_POW}` },
    ],
  }),
  red_suits: (v) => ({
    summary: '提高方块与红桃的倍率',
    lines: [
      { when: EACH_SPIN, effect: `场上每个方块的本轮倍率 ×${n(v, 0)}${STACK_POW}` },
      { when: EACH_SPIN, effect: `场上每个红桃的本轮倍率 ×${n(v, 0)}${STACK_POW}` },
    ],
  }),
  conveyor_belt: (v) => ({
    summary: '提高所有「生成器」符号的额外倍率',
    lines: [
      { when: EACH_SPIN, effect: `场上每个生成器类符号的额外倍率 ×${n(v, 0)}${STACK_POW}` },
    ],
  }),
  chicken_coop: (v) => ({
    summary: '提高家禽产出，并提高母鸡与蛋的倍率',
    lines: [
      { when: EACH_SPIN, effect: `场上每个家禽类符号数值 +${n(v, 2)}${STACK_SUM}` },
      { when: EACH_SPIN, effect: `场上每个母鸡的额外倍率 ×${n(v, 0)}${STACK_POW}` },
      { when: EACH_SPIN, effect: `场上每个蛋的额外倍率 ×${n(v, 1)}${STACK_POW}` },
    ],
  }),
  fertilizer: (v) => ({
    summary: '提高种子产出；种子会长成植物',
    lines: [
      { when: EACH_SPIN, effect: `场上每个种子的额外数值 +${n(v, 0)}${STACK_SUM}` },
      {
        when: '种子本转还没变过形',
        effect: '按自身数值判定概率，把种子换成随机植物，稀有度至少「稀有」',
      },
    ],
  }),
  watering_can: (v) => ({
    summary: '提高种子数值；按持有道具决定种子长成植物的稀有度',
    lines: [
      { when: EACH_SPIN, effect: `场上每个种子数值 +${n(v, 1)}${STACK_SUM}` },
      {
        when: '种子本转还没变过形',
        effect:
          '换成随机植物，档位随持有物提升：什么都没持有→任意档；持有堆肥→至少罕见；持有肥料→至少稀有；持有肥料精华→「极稀有」，并消耗 1 个肥料精华',
      },
    ],
    gap: '细则 34 生效时，这条变形整体不触发。',
  }),
  lemon: (v) => ({
    summary: '空位数量越多，加成就越高',
    lines: [{ when: EACH_SPIN, effect: `场上每个空位让本道具数值 +${n(v, 0)}${STACK_SUM}` }],
    selfValueOnly: true,
    gap: '空位不是符号、自身不产出，所以加成只能记在本道具上。',
  }),
  tax_evasion: (v) => ({
    summary: '补贴负收益符号',
    lines: [
      {
        when: EACH_SPIN,
        effect: `场上每个结算后仍为负值的符号，数值 +${n(v, 0)}${STACK_SUM}`,
      },
    ],
  }),
  mining_pick: (v) => ({
    summary: '吸收被摧毁的矿工亲和符号',
    lines: [
      {
        when: '矿工亲和类符号本转被摧毁时',
        effect: `该符号的数值 +${n(v, 0)}，结算一次${STACK_SUM}`,
      },
    ],
  }),
  looting_glove: (v) => ({
    summary: '提高被摧毁箱具的倍率',
    lines: [
      { when: '箱具类符号本转已被摧毁时', effect: `该符号的本轮倍率 ×${n(v, 0)}${STACK_POW}` },
    ],
  }),
  wanted_poster: (v) => ({
    summary: '提高所有小偷的倍率',
    lines: [
      { when: EACH_SPIN, effect: `场上每个小偷的本轮倍率 ×${n(v, 0)}${STACK_POW}` },
      {
        when: '小偷已被摧毁，且它本转还没拿到固定加成',
        effect: '该小偷的固定加成 +1',
      },
    ],
  }),
  grave_robber: (v) => ({
    summary: '随机摧毁灵盒符号',
    lines: [
      {
        when: EACH_SPIN,
        effect: '每个灵盒类符号各自按「数值 ≥ 0–100 的随机数」判定，判定通过就被摧毁',
      },
    ],
    gap: `判定用的是本道具的数值 ${n(v, 0)}，等价于每个灵盒有约 ${n(v, 0)}% 概率被摧毁。`,
  }),
  lockpick: (v) => ({
    summary: '随机摧毁箱具符号',
    lines: [
      {
        when: EACH_SPIN,
        effect:
          '每个还没被标为待摧毁的箱具类符号，各自按「数值 ≥ 0–100 的随机数」判定，通过就被摧毁',
      },
    ],
    gap: `判定用的是本道具的数值 ${n(v, 0)}，等价于每个箱具有约 ${n(v, 0)}% 概率被摧毁。`,
  }),
  guillotine: () => ({
    summary: '直接摧毁亿万富翁',
    lines: [{ when: EACH_SPIN, effect: '场上每个亿万富翁被摧毁' }],
  }),
  frying_pan: () => ({
    summary: '蛋被摧毁时生成煎蛋卷',
    lines: [{ when: '蛋本转被摧毁时', effect: '在空位生成 1 个煎蛋卷，每持有一层多 1 个' }],
  }),
  shrine: () => ({
    summary: '生物死亡时召唤幽灵',
    lines: [
      {
        when: '生物类符号本转被摧毁时',
        effect: '在空位生成幽灵，数量等于本道具的持有层数',
      },
    ],
  }),
  mobius_strip: (v) => ({
    summary: '被摧毁的箱具原样回到棋盘',
    lines: [
      { when: '箱具类符号本转被摧毁时', effect: `有 ${n(v, 0)}% 概率把它原样放回棋盘空格` },
    ],
    gap: `累计补回次数上限为 ${n(v, 1)} 次，用满后不再触发。`,
  }),
  void_party: (v) => ({
    summary: '虚空符号退回普通稀有度，被摧毁时原样补回',
    lines: [
      { when: EACH_SPIN, effect: '场上每个虚空类符号的稀有度改为「普通」' },
      { when: '虚空类符号本转被摧毁时', effect: `有 ${n(v, 0)}% 概率把它原样放回棋盘空格` },
    ],
    gap: `累计补回次数上限为 ${n(v, 1)} 次，用满后不再触发。`,
  }),
  reroll: (v) => ({
    summary: '重掷骰子的低加成',
    lines: [
      {
        when: EACH_SPIN,
        effect: `三面骰本轮加成 ≥1 且 <${n(v, 0)} 时，重掷为 1–3 的随机值（覆盖原加成）`,
      },
      {
        when: EACH_SPIN,
        effect: `五面骰本轮加成 ≥1 且 <${n(v, 1)} 时，重掷为 1–5 的随机值（覆盖原加成）`,
      },
    ],
    gap: '持有重掷精华时这条不触发，改由精华自己的规则结算。',
  }),
  shedding_season: (v) => ({
    summary: '提高兔子产出并持续生成兔毛',
    lines: [
      { when: EACH_SPIN, effect: `场上每个兔子的额外数值 +${n(v, 0)}${STACK_SUM}` },
      { when: EACH_SPIN, effect: '场上每个兔子按自身数值判定概率，通过就在空位生成 1 个兔毛' },
    ],
  }),

  /* ── 稀有度 / 出现权重 ── */
  lucky_cat: (v) => ({
    summary: '提高猫的出现权重',
    lines: [
      {
        when: '持有期间，商店抽卡时',
        effect: `猫在罕见 / 稀有 / 极稀有三档的出现权重 ×${n(v, 0)}${STACK_POW}`,
      },
    ],
  }),
  lucky_carrot: (v) => ({
    summary: '提高自身出现权重，并提高兔子倍率',
    lines: [
      {
        when: '持有期间，商店抽卡时',
        effect: `本道具在罕见 / 稀有 / 极稀有三档的出现权重 ×${n(v, 0)}${STACK_POW}`,
      },
      { when: EACH_SPIN, effect: `场上每个兔子的本轮倍率 ×${n(v, 1)}${STACK_POW}` },
    ],
  }),
  golden_carrot: (v) => ({
    summary: '提高自身出现权重，并提高兔子倍率',
    lines: [
      {
        when: '持有期间，商店抽卡时',
        effect: `本道具在罕见 / 稀有 / 极稀有三档的出现权重 ×${n(v, 0)}${STACK_POW}`,
      },
      { when: EACH_SPIN, effect: `场上每个兔子的本轮倍率 ×${n(v, 1)}${STACK_POW}` },
    ],
  }),

  /* ── 只在「持有本道具时」改写别的符号的规则 ── */
  fifth_ace: (v) => ({
    summary: '让相邻的红黑花色互相加成',
    lines: [
      {
        when: '持有期间，相邻的两个符号分属「梅花 / 黑桃」与「方块 / 红桃」时',
        effect: `两边的数值各 +${n(v, 0)}${STACK_SUM}`,
      },
    ],
  }),
  ninja_and_mouse: (v) => ({
    summary: '忍者与老鼠相邻时互相提高倍率',
    lines: [
      {
        when: '持有期间，忍者紧邻老鼠时（每格每转只结算一次）',
        effect: `该忍者的本轮倍率 ×${n(v, 0)}${STACK_POW}`,
      },
      {
        when: '持有期间，老鼠紧邻忍者时（每格每转只结算一次）',
        effect: `该老鼠的本轮倍率 ×${n(v, 0)}${STACK_POW}`,
      },
    ],
  }),
  dark_humor: (v) => ({
    summary: '喜剧演员相邻黑色幽默时获得倍率',
    lines: [
      {
        when: '持有期间，喜剧演员紧邻黑色幽默类符号时',
        effect: `该喜剧演员的本轮倍率 ×${n(v, 1)}${STACK_POW}`,
      },
    ],
  }),
  zaroffs_contract: (v) => ({
    summary: '赏金猎人改为猎杀人类',
    lines: [
      {
        when: '跑「持有扎罗夫契约」这套分支时',
        effect: '赏金猎人摧毁紧邻的「人类类」符号，并把被摧毁符号的数值累加到自身',
      },
      {
        when: '没持有扎罗夫契约时（默认分支）',
        effect: '赏金猎人改为摧毁紧邻的小偷',
      },
      {
        when: '赏金猎人摧毁了目标',
        effect: `自身数值 +${n(v, 0)}，每持有一层再叠一次`,
      },
    ],
    gap: '「消耗扎罗夫契约精华」「消耗通缉令精华」两条分支各自额外结算一次赏金。',
  }),
  undertaker: () => ({
    summary: '幽灵不再自毁',
    lines: [
      {
        when: '幽灵的给币次数达到阈值、本应自毁时',
        effect: '这条自毁被取消，幽灵继续留在场上',
      },
    ],
    gap: '数据把默认自毁写在「未持有殡葬师」的分支里：持有本道具后该分支关闭。',
  }),
  x_ray_machine: () => ({
    summary: '矿石被摧毁时生成宝石',
    lines: [{ when: '矿石类符号本转被摧毁时', effect: '在空位生成 1 个宝石类符号' }],
    gap: '数据把这条挂在「未持有 X 光机」的分支上，与「持有后生效」的本意相反，疑为抽取瑕疵；按设计意图展示。',
  }),

  /* ── 随身计数：移除符号 / 累积层数 ── */
  egg_carton: (v) => ({
    summary: '移除场上的蛋并累积自身价值',
    lines: [
      {
        when: EACH_SPIN,
        effect: `移除场上所有蛋，每移除 1 个累积 +${n(v, 0)}（上限 ${n(v, 1)}）`,
      },
      { when: '持有期间', effect: `道具自身价值 = 累积 × ${n(v, 0)}` },
    ],
    selfValueOnly: true,
    gap: '细则 21 生效时不移除蛋。',
  }),
  fish_bowl: (v) => ({
    summary: '移除场上的金鱼并累积自身价值',
    lines: [
      { when: EACH_SPIN, effect: `移除场上所有金鱼，每移除 1 个累积 +${n(v, 0)}` },
      { when: '持有期间', effect: `道具自身价值 = 累积 × ${n(v, 0)}` },
    ],
    selfValueOnly: true,
  }),
  coin_on_a_string: (v) => ({
    summary: '移除场上的金币并提高自身价值',
    lines: [
      {
        when: EACH_SPIN,
        effect: `移除场上所有金币，每移除 1 个道具自身价值 +${n(v, 1)}`,
      },
    ],
    selfValueOnly: true,
    gap: '细则 20 生效时不移除金币。',
  }),
  lint_roller: (v) => ({
    summary: '移除场上的兔毛并提高自身价值',
    lines: [
      {
        when: EACH_SPIN,
        effect: `移除场上所有兔毛，每移除 1 个道具自身价值 +${n(v, 0)}${STACK_SUM}`,
      },
    ],
    selfValueOnly: true,
  }),
  cardboard_box: (v) => ({
    summary: '累积每转 +1；达到阈值后给予移除代币',
    lines: [
      { when: EACH_SPIN, effect: '累积 +1；累积达到 ' + n(v, 1) + ' 时，移除代币 +' + n(v, 0) + ' 并将累积清零' },
    ],
  }),
  credit_card: (v) => ({
    summary: '累积每转 +1；达到阈值后清零',
    lines: [
      { when: EACH_SPIN, effect: `累积 +1；累积达到 ${n(v, 0)} 时清零，重新计数` },
    ],
    gap: `第 2 个数值 ${n(v, 1)} 在原版数据表中未被任何规则引用，这里同样不参与结算。`,
  }),
  shattered_mirror: (v) => ({
    summary: '累积达到阈值后提高自身价值',
    lines: [
      { when: EACH_SPIN, effect: `累积 +1；累积达到 ${n(v, 1)} 时，道具自身价值 +${n(v, 0)} 并将累积清零` },
    ],
    selfValueOnly: true,
  }),
  dishwasher: (v) => ({
    summary: '累积达到阈值后给予精华代币',
    lines: [
      { when: EACH_SPIN, effect: `累积 +1；累积达到 ${n(v, 1)} 时，精华代币 +${n(v, 0)} 并将累积清零` },
    ],
  }),
  sunglasses: (v) => ({
    summary: '移除代币够多时继续加',
    lines: [
      { when: `当前移除代币 ≥ ${n(v, 1)} 时`, effect: `移除代币 +${n(v, 0)}（每转结算一次）` },
    ],
  }),
  recycling: (v) => ({
    summary: '每转给重掷代币',
    lines: [{ when: EACH_SPIN, effect: `重掷代币 +${n(v, 0)}` }],
  }),
  lucky_seven: (v) => ({
    summary: '持有层数达到阈值后变为高价值',
    lines: [
      {
        when: `持有层数 ≥ ${n(v, 0)} 时`,
        effect: `道具自身价值变为 ${n(v, 1)}，并在结算后扣掉 ${n(v, 0)} 层`,
      },
    ],
    selfValueOnly: true,
  }),
  oil_can: (v) => ({
    summary: '被重摇过的列产出翻倍',
    lines: [
      { when: '本转这一列被重摇过时', effect: `该列上每个符号的本轮倍率 ×${n(v, 1)}${STACK_POW}` },
    ],
    gap: `第 1 个数值 ${n(v, 0)} 在原版中只用于界面显示累积次数，不参与产出结算。`,
  }),
  // telescope / protractor 的邻接扩展依赖原版的「clump 分组层」：
  // `Main__Reels.gd:1583-1630` 先把所有同类符号归组（`add_to_clump`），
  // 组内成员互视为相邻；telescope 让全场参与分组，protractor 追加 4 条角-角连线。
  // 本实现的结算按格 8 邻域展开，没有这一层，因此这两件目前只做累积。
  telescope: (v) => ({
    summary: '每转累积 1 层',
    lines: [{ when: EACH_SPIN, effect: '累积 +1' }],
    selfValueOnly: true,
    gap: `原版在第 ${n(v, 0)} 层起会把全场的同类符号归入同一组、组内互相视为相邻；当前结算只按八邻域展开，该效果暂不生效。`,
  }),
  protractor: (v) => ({
    summary: '每转累积 1 层',
    lines: [{ when: EACH_SPIN, effect: '累积 +1' }],
    selfValueOnly: true,
    gap: `原版在第 ${n(v, 0)} 层起会让棋盘四角互视为相邻；当前结算只按八邻域展开，该效果暂不生效。`,
  }),
  frozen_pizza: (v) => ({
    summary: '每转累积；达到上限后追加一次符号奖励',
    lines: [
      { when: EACH_SPIN, effect: '累积 +1' },
      { when: `累积达到 ${n(v, 0)} 时`, effect: '付租奖励时额外获得一次符号三选一，累积清零' },
    ],
    selfValueOnly: true,
  }),
  treasure_map: (v) => ({
    summary: '每转累积，达到上限后挖出钥匙与宝箱',
    lines: [
      { when: EACH_SPIN, effect: '累积 +1' },
      { when: `累积达到 ${n(v, 0)} 时`, effect: '获得钥匙与宝箱，宝藏图本身消耗' },
    ],
    selfValueOnly: true,
    gap: `累积未达 ${n(v, 0)} 之前无法被摧毁。`,
  }),

  /* ── 只改道具自身价值 ── */
  bowling_ball: (v) => ({
    summary: '自身价值固定为一个较高值',
    lines: [{ when: '持有期间', effect: `道具自身价值恒为 ${n(v, 0)}` }],
    selfValueOnly: true,
  }),
  four_leaf_clover: (v) => ({
    summary: '自身价值固定为一个较高值',
    lines: [{ when: '持有期间', effect: `道具自身价值恒为 ${n(v, 0)}` }],
    selfValueOnly: true,
  }),
  horseshoe: (v) => ({
    summary: '自身价值固定为一个较高值',
    lines: [{ when: '持有期间', effect: `道具自身价值恒为 ${n(v, 0)}` }],
    selfValueOnly: true,
  }),
  pool_ball: (v) => ({
    summary: '自身价值固定',
    lines: [{ when: '持有期间', effect: `道具自身价值恒为 ${n(v, 0)}` }],
    selfValueOnly: true,
  }),
  piggy_bank: (v) => ({
    summary: '将自身价值转化为累积；付不起租时可销毁换钱',
    lines: [
      { when: EACH_SPIN, effect: `道具自身价值 -${n(v, 0)}` },
      { when: EACH_SPIN, effect: `累积 +${n(v, 0)}` },
      { when: '付不起租时销毁', effect: `获得 累积 × ${n(v, 1)} 金币，同时对房东造成等量伤害` },
    ],
    selfValueOnly: true,
  }),
  swear_jar: (v) => ({
    summary: '自身价值为负；付不起租时可销毁换钱',
    lines: [
      { when: EACH_SPIN, effect: `道具自身价值 -${n(v, 0)}` },
      { when: '付不起租时销毁', effect: `获得 累积 × ${n(v, 1)} 金币，同时对房东造成等量伤害` },
    ],
    selfValueOnly: true,
    gap: `累积上限 ${n(v, 2)}。`,
  }),
  black_cat: (v) => ({
    summary: '提高猫的倍率；自身价值较高',
    lines: [
      { when: EACH_SPIN, effect: `场上每个猫的本轮倍率 ×${n(v, 2)}${STACK_POW}` },
      { when: '持有期间', effect: `道具自身价值 +${n(v, 0)}（不参与产出）` },
    ],
    gap: `第 2 个数值 ${n(v, 1)} 在原版数据表中未被引用，不参与结算。`,
  }),
  lefty_the_rabbit: (v) => ({
    summary: '累积后生成兔毛，并提高第一列兔子与兔毛的倍率',
    lines: [
      { when: EACH_SPIN, effect: `累积 +1；累积达到 ${n(v, 0)} 时，扣除 ${n(v, 0)} 层并在空位生成 1 个兔毛` },
      { when: EACH_SPIN, effect: `第一列上的每个兔子、兔毛，本轮倍率 ×${n(v, 1)}${STACK_POW}` },
    ],
  }),
  rusty_gear: (v) => ({
    summary: '被触发后提高自身倍率',
    lines: [
      {
        when: '本符号本转已被其他符号触发过',
        effect: `道具自身本轮倍率 ×${n(v, 1)}${STACK_POW}`,
      },
    ],
    selfValueOnly: true,
  }),
  flush: (v) => ({
    summary: '被触发就自毁，自毁时变成 77',
    lines: [
      { when: '被其他符号触发过时', effect: '摧毁自己' },
      { when: '被摧毁时', effect: `道具自身价值变为 ${n(v, 0)}` },
    ],
    selfValueOnly: true,
    gap: '道具不在棋盘上，「被摧毁」永远不会发生，所以这两条实际都不触发。',
  }),
  turtle_and_rabbit: (v) => ({
    summary: '被触发就自毁，自毁时变成 77',
    lines: [
      { when: '被其他符号触发过时', effect: '摧毁自己' },
      { when: '被摧毁时', effect: `道具自身价值变为 ${n(v, 0)}` },
    ],
    selfValueOnly: true,
    gap: '道具不在棋盘上，「被摧毁」永远不会发生，所以这两条实际都不触发。',
  }),
  black_pepper: (v) => ({
    summary: '本转被摧毁的符号越多，自身价值越高',
    lines: [
      {
        when: EACH_SPIN,
        effect: `道具自身价值被抬到「本转被摧毁的符号数 × ${n(v, 0)}」，只升不降`,
      },
    ],
    selfValueOnly: true,
  }),
  brown_pepper: () => ({
    summary: '本转生成的符号越多，自身价值越高',
    lines: [{ when: EACH_SPIN, effect: '道具自身价值被抬到「本转新生成的符号数」，只升不降' }],
    selfValueOnly: true,
  }),
  chili_powder: () => ({
    summary: '已持有的胡椒越多，自身价值越高',
    lines: [
      {
        when: EACH_SPIN,
        effect: '道具自身价值被抬到「已持有的胡椒类道具总数」，只升不降',
      },
    ],
    selfValueOnly: true,
  }),
  white_pepper: (v) => ({
    summary: '自身价值随层数累加',
    lines: [{ when: EACH_SPIN, effect: `道具自身价值 +${n(v, 0)}${STACK_SUM}` }],
    selfValueOnly: true,
  }),
  red_pepper: (v) => pepperSelf(v),
  green_pepper: (v) => pepperSelf(v),
  blue_pepper: (v) => pepperSelf(v),
  cyan_pepper: (v) => pepperSelf(v),
  purple_pepper: (v) => pepperSelf(v),
  yellow_pepper: (v) => pepperSelf(v),
  compost_heap: (v) => ({
    summary: '按被摧毁的符号数生成种子',
    lines: [
      { when: EACH_SPIN, effect: '累积值跟随全场「累计被摧毁的符号数」上涨' },
      {
        when: `累积值领先累计摧毁数 ${n(v, 0)} 个以上时`,
        effect: `在空位生成 1 个种子，并把累计摧毁数扣掉 ${n(v, 0)}`,
      },
    ],
    gap: '该规则需要记录全场累计摧毁数，当前结算管线未维护这个计数，因此短期内不会触发。',
  }),
  void_portal: (v) => ({
    summary: '按已摧毁的符号种类数缩放自身价值',
    lines: [
      { when: '本道具被摧毁时', effect: '记下「已摧毁过的符号种类数」' },
      { when: EACH_SPIN, effect: `道具自身价值被抬到「记录值 ÷ ${n(v, 1)}」，只升不降` },
    ],
    selfValueOnly: true,
    gap: `第 1 个数值 ${n(v, 0)} 在原版数据表中未被引用，不参与结算。`,
  }),

  /* ── 换位 ── */
  swapping_device: () => ({
    summary: '每转给一次换位机会',
    lines: [
      {
        when: '每转停盘之后、结算之前',
        effect: '可以交换棋盘上任意两个符号的位置；每转只能换一次，也可以不换',
      },
    ],
  }),

  /* ── 没有任何效果声明的道具 ── */
  ancient_lizard_blade: () => todo(),
  bag_of_holding: () => todo(),
  capsule_machine: () => todo(),
  checkered_flag: () => todo(),
  clear_sky: () => todo(),
  comfy_pillow: () => todo(),
  copycat: () => todo(),
  cursed_katana: () => todo(),
  devils_deal: () => todo(),
  gray_pepper: () => todo(),
  item_missing: () => ({ summary: '占位道具', lines: [], gap: '这不是一件真实道具，出现在商店里属于数据缺失。' }),
  lime_pepper: () => todo(),
  pink_pepper: () => todo(),
  popsicle: () => todo(),
  quiver: () => todo(),
  time_machine: () => todo(),
  lucky_dice: () => ({
    ...todo(),
    gap: '规则引用了 values[0] / values[1]，但这件道具的 values 是空的，公式无解。',
  }),
};

/**
 * 同一条件下挂多条效果时合并成一行。
 * 蓝西装、鸡舍这类道具的每条规则都在「每转结算时」触发，逐条列出会重复同一句话，
 * 读者还得自己判断这些条件是不是同一个。
 */
function mergeSameWhen(lines: ItemLine[]): ItemLine[] {
  const out: ItemLine[] = [];
  const at = new Map<string, number>();
  for (const line of lines) {
    const seen = at.get(line.when);
    if (seen === undefined) {
      at.set(line.when, out.length);
      out.push({ ...line });
    } else {
      out[seen] = { when: line.when, effect: `${out[seen].effect}；${line.effect}` };
    }
  }
  return out;
}

/** 取一件道具的结构化说明；未收录返回 null（调用方回退到通用渲染） */
export function itemDesc(id: string): ItemDesc | null {
  const build = DESC[id];
  if (!build) return null;
  const def = ITEM_BY_ID.get(id);
  const values = (def?.values ?? []) as number[];
  const desc = build(values);
  return { ...desc, lines: mergeSameWhen(desc.lines) };
}

/** 描述表是否覆盖了这件道具（自检用） */
export function hasItemDesc(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(DESC, id);
}
