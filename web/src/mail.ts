// 房东信箱：原作把叙事、教学和「同伴援助」都做成信件（Pop-up__Pop-up.gd:224 load_emails）。
// 原文案在 res://JSON/Emails - JSON.json 与翻译表里，仓库没有这部分资源，
// 这里按同样的邮件类型自写中文文案；凡涉及我们改过名的符号/道具，
// 一律写成「图标 中文名(英文 id)」，方便与原作对照（如 🌶辣椒(Chili Powder)）。
import { SYMBOL_BY_ID } from './data';
import { emojiOf } from './sprites';
import { bilingualName } from './names';

export type MailKind =
  | 'init_comrade_help'
  | 'comrade_help'
  | 'rent_due'
  | 'chili_powder_essence_prompt'
  | 'removal_token_prompt'
  | 'rent_increase'
  | 'boss_fight_1'
  | 'boss_fight_2'
  | 'intro'
  | 'ending'
  | 'game_over'
  // 以下三种来自原版邮件表（res://JSON/Emails - JSON.json）：细则通知、付清 12 期、道具栏说明
  | 'fine_print'
  | 'win'
  | 'inventory';

export interface MailReward {
  reroll: number;
  removal: number;
  essence: number;
}

export interface Mail {
  id: string;
  kind: MailKind;
  from: string;
  subject: string;
  body: string;
  /** 已自动入账的代币，仅用于正文与界面展示 */
  reward?: MailReward;
  read: boolean;
  turn: number;
}

const FROM_LANDLORD = '房东';
const FROM_COMRADES = '三位同伴';
const FROM_HOUSE = '公寓管理处';

/** 「图标 中文名(英文名)」，邮件里所有道具/符号名都走这里 */
export function tagOf(id: string): string {
  const def = SYMBOL_BY_ID.get(id);
  return `${def ? emojiOf(def) : ''}${bilingualName(id)}`;
}

/**
 * 同伴能凑出的代币数量，随楼层递减（Pop-up__Pop-up.gd:1284-1295）：
 * 第 1-3 层 [2,2,2]，第 4-8 层 [2,1,2]，第 9-15 层 [1,1,2]，第 16 层起 [1,1,1]。
 */
export function comradeValues(floor: number): MailReward {
  if (floor >= 16) return { reroll: 1, removal: 1, essence: 1 };
  if (floor >= 9) return { reroll: 1, removal: 1, essence: 2 };
  if (floor >= 4) return { reroll: 2, removal: 1, essence: 2 };
  return { reroll: 2, removal: 2, essence: 2 };
}

function mail(
  kind: MailKind,
  from: string,
  subject: string,
  body: string,
  turn: number,
  reward?: MailReward,
): Mail {
  return { id: `${kind}-${turn}`, kind, from, subject, body, reward, read: false, turn };
}

/** 同伴援助信：第 3 期第一次，之后每逢奇数期（Pop-up__Pop-up.gd:2925-2945） */
export function comradeMail(floor: number, first: boolean, turn: number): Mail {
  const v = comradeValues(floor);
  const lines = [
    first
      ? '「别慌，我们先垫一点。这点家当拿去用，别把房子输给那个房东。」'
      : '「这个月的份子钱凑齐了，拿着。」',
    `第 ${floor} 层的份子钱：♻️ ${v.reroll}、🗑️ ${v.removal}、💎 ${v.essence}。越往上，我们能凑的越少。`,
  ];
  if (first) {
    lines.push(
      `♻️ 重掷在商店里换一批候选；🗑️ 移除可以把不想要的符号删掉（先点顶部 🗑️）；💎 精华能把道具升级成精华版。`,
    );
  }
  return mail(
    first ? 'init_comrade_help' : 'comrade_help',
    FROM_COMRADES,
    first ? '同伴来信：先借你一点' : '同伴来信：份子钱',
    lines.join('\n\n'),
    turn,
    v,
  );
}

/** 付租前的催租信（Pop-up__Pop-up.gd:937 rent_due） */
export function rentDueMail(ctx: {
  period: number;
  rent: number;
  coins: number;
  essenceTokens: number;
  removalCost: number;
  turn: number;
}): Mail {
  const short = Math.max(0, ctx.rent - ctx.coins);
  const lines = [
    `第 ${ctx.period} 期：租金 ${ctx.rent}，你手上有 ${ctx.coins} 金币${short > 0 ? `，还差 ${short}` : '，够了'}。`,
    '旋转次数已经用尽，该付账了。',
  ];
  if (ctx.essenceTokens > 0) {
    lines.push(
      `💎 精华代币 ${ctx.essenceTokens} 个：付租时没花掉的会被房东收走，能升级的道具（点道具栏）先升了。`,
    );
  }
  lines.push(`🗑️ 移除代币每次消耗 ${ctx.removalCost}，删符号不花金币，别浪费。`);
  return mail('rent_due', FROM_LANDLORD, '这期的账', lines.join('\n\n'), ctx.turn);
}

/** 第一次买到辣椒时，教精华怎么用（chili_powder_essence_prompt） */
export function chiliEssenceMail(essenceTokens: number, turn: number): Mail {
  return mail(
    'chili_powder_essence_prompt',
    FROM_HOUSE,
    `关于 ${tagOf('chili_powder')}`,
    [
      `你拿到了 ${tagOf('chili_powder')}。`,
      `💎 精华代币（你现在 ${essenceTokens} 个）可以把它升级成 ${tagOf('chili_powder_essence')}。`,
      '点下面道具栏里的图标 →「精华化」即可。',
    ].join('\n\n'),
    turn,
  );
}

/** 第一次拿到移除代币时的用法说明（removal_token_prompt） */
export function removalTipMail(cost: number, turn: number): Mail {
  return mail(
    'removal_token_prompt',
    FROM_HOUSE,
    '🗑️ 移除代币怎么用',
    [
      `点顶部的 🗑️ 进入移除模式，再点棋盘上任意符号就能删掉它，每次消耗 ${cost} 个代币。`,
      `例：${tagOf('cat')} 这种只给自己加分的符号，占着格子却帮不上邻居时，删掉比留着划算。`,
      '删掉的符号会从池里一起消失，不会再被抽到。',
    ].join('\n\n'),
    turn,
  );
}

/** 付租后租金上涨（原版 rent_increase；无尽模式每期都发） */
export function rentIncreaseMail(ctx: {
  period: number;
  nextRent: number;
  spinsGain: number;
  endless: boolean;
  turn: number;
}): Mail {
  return mail(
    'rent_increase',
    FROM_LANDLORD,
    ctx.endless ? '房租还没有上限' : '下一期的账',
    [
      `第 ${ctx.period} 期付清了。下一期租金 ${ctx.nextRent}，旋转 +${ctx.spinsGain}。`,
      ctx.endless
        ? '无尽模式不设终点：租金一直涨，撑不住就结算。'
        : '租子只会越滚越大，别把金币全押在不涨的格子上。',
    ].join('\n\n'),
    ctx.turn,
  );
}

/** 开局：房东的第一封信（原版 intro） */
export function introMail(mode: 'normal' | 'sandbox' | 'endless', turn: number): Mail {
  const lines = [
    `我是这栋楼的房东。规则很简单：每期先把租金凑齐，凑不齐就滚出去。`,
    '旋转转出产出 → 用金币把好符号买进牌库 → 棋盘上摆满之后，同样的支出能换回更多钱。',
    '格子少、符号挤，产出才长得快；只会堆高价符号而不让它们挨在一起，是赚不到钱的。',
  ];
  if (mode === 'sandbox') {
    lines.push(
      '沙盒模式：从第 12 期开始，金币 999,999，另送重掷 / 移除 / 精华各 3 枚，随便试。付租会继续推进期数，解锁更高的楼层档位。',
    );
  } else if (mode === 'endless') {
    lines.push('无尽模式：没有第 12 期的终点，租金会一直涨，撑到你付不出为止。');
  } else {
    lines.push('付完 12 期，你就自由了——不过房东我可能会亲自来一趟。');
  }
  lines.push('有信我会塞进上面的 📬 信箱，记得看。');
  return mail('intro', FROM_LANDLORD, '房东的第一封信', lines.join('\n\n'), turn);
}

/** 房东倒下后的收尾信（ending） */
export function endingMail(ctx: { rent: number; totalEarned: number; turn: number }): Mail {
  return mail(
    'ending',
    FROM_LANDLORD,
    '这栋楼归你了',
    [
      `最后一期租金 ${ctx.rent}，本局累计产出 ${ctx.totalEarned}。`,
      '我倒了。房租、纸条、那些破规则，都归你了。成就与统计已经写进本地存档。',
    ].join('\n\n'),
    ctx.turn,
  );
}

/** 房东亲自下场（官方 id：boss_fight_1，Pop-up__Pop-up.gd:560-570） */
export function bossMail(hp: number, turn: number): Mail {
  return mail(
    'boss_fight_1',
    FROM_LANDLORD,
    '房东亲自下场',
    [
      '12 期租金你都付清了，所以我亲自来。',
      `我的血量 ${hp}。别想着跑——这一场打完，这栋楼才算有个结果。`,
    ].join('\n\n'),
    turn,
  );
}

/** 战斗规则（官方 id：boss_fight_2，Pop-up__Pop-up.gd:605-615） */
export function bossFightMail2(hp: number, turn: number): Mail {
  return mail(
    'boss_fight_2',
    FROM_LANDLORD,
    '那就开打',
    [
      `我站在这儿，${hp} 点血，一回合比一回合更恼火。`,
      '你每转赚到的金币会同时打进我的血条，一个子儿都不会留在你口袋里；租金照付，付不出来就滚出去。',
      '打空我的血，这栋楼归你。',
    ].join('\n\n'),
    turn,
  );
}

/**
 * 新细则生效的通知信（原版邮件 kind：fine_print）。
 * 原版在拿到细则时发一封信把纸条塞进信箱，这里同样把编号、名字和数值写进正文；
 * 同类信只留最新一封（addMail 按 kind 去重），所以信箱不会被子规则堆满。
 */
export function finePrintMail(ctx: {
  num: number;
  name?: string;
  values: number[];
  dynamicIcon?: string;
  turn: number;
}): Mail {
  const lines = [`细则 #${ctx.num}「${ctx.name ?? `细则 ${ctx.num}`}」从下回转开始生效。`];
  if (ctx.values.length > 0) lines.push(`这条的数值：${ctx.values.join(' / ')}。`);
  if (ctx.dynamicIcon) lines.push(`它盯上的符号：${tagOf(ctx.dynamicIcon)}。`);
  lines.push('细则不需要你操作，会自动叠到结算上；想不起来自己有哪些，随时点开左侧的细则列表。');
  return mail('fine_print', FROM_LANDLORD, `细则 #${ctx.num}`, lines.join('\n\n'), ctx.turn);
}

/** 付清 12 期（原版邮件 kind：win）：房东还没认输，但欠条已经付完一轮 */
export function winMail(ctx: { period: number; rent: number; totalEarned: number; turn: number }): Mail {
  return mail(
    'win',
    FROM_LANDLORD,
    '12 期付清了',
    [
      `第 ${ctx.period} 期租金 ${ctx.rent} 也付清了。按租约，你本来该拿钥匙了。`,
      `本局累计产出 ${ctx.totalEarned}。不过你别急着搬家——我打算亲自来一趟。`,
    ].join('\n\n'),
    ctx.turn,
  );
}

/** 第一次买到道具：介绍道具栏（原版邮件 kind：inventory） */
export function inventoryMail(turn: number): Mail {
  return mail(
    'inventory',
    FROM_HOUSE,
    '关于你刚买的道具',
    [
      '道具不进牌库，直接生效，永久留在这一局里。',
      '同一种道具再买一次会叠层（右上角的 ×2、×3），叠得越高效果越强。',
      '💎 精华代币可以把它升级成精华版：点道具图标 →「精华化」。付租时没花掉的精华会被房东收走。',
    ].join('\n\n'),
    turn,
  );
}

/** 破产（game_over） */

export function gameOverMail(ctx: { period: number; rent: number; coins: number; turn: number }): Mail {
  return mail(
    'game_over',
    FROM_LANDLORD,
    '你被扫地出门了',
    [
      `第 ${ctx.period} 期租金 ${ctx.rent}，你只凑到 ${ctx.coins}。`,
      '精华代币在付租时会作废，能升级就早点升。',
    ].join('\n\n'),
    ctx.turn,
  );
}
