// 房东信箱：原作把叙事、教学与「同伴援助」都做成信件（Pop-up__Pop-up.gd:224 load_emails）。
// 原文案在 res://JSON/Emails - JSON.json 与翻译表里，仓库没有这部分资源，
// 这里按同样的邮件类型自写中文文案；凡涉及我们改过名的符号/道具，
// 一律写成「图标 中文名(英文 id)」，方便与原作对照（如 🌶辣椒(Chili Powder)）。
//
// 文案口径：说明规则与状态，不使用玩笑、绰号或感叹式口语。
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
      ? '我们凑了一份代币给你，请收下。往后每当租金上涨，我们仍会尽力支援。'
      : '本月可支援的代币已凑齐，随信附上。',
    `第 ${floor} 层可提供的数量：重掷 ${v.reroll} 枚、移除 ${v.removal} 枚、精华 ${v.essence} 枚。楼层越高，可凑出的数量越少。`,
  ];
  if (first) {
    lines.push(
      '重掷代币可在商店里更换一批候选；移除代币用于删除不需要的符号（先点顶部的删除按钮）；精华代币可把道具升级为精华版。',
    );
  }
  return mail(
    first ? 'init_comrade_help' : 'comrade_help',
    FROM_COMRADES,
    first ? '同伴来信：首批援助' : '同伴来信：本期支援',
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
    `第 ${ctx.period} 期租金 ${ctx.rent}，当前持有 ${ctx.coins} 金币${short > 0 ? `，尚差 ${short}` : '，已足够支付'}。`,
    '本期旋转次数已用尽，请结算租金。',
  ];
  if (ctx.essenceTokens > 0) {
    lines.push(
      `尚有 ${ctx.essenceTokens} 枚精华代币：付租时未使用的部分不会保留，建议先到道具栏完成升级。`,
    );
  }
  lines.push(`移除代币每次消耗 ${ctx.removalCost} 枚，删除符号不消耗金币。`);
  return mail('rent_due', FROM_LANDLORD, '第 ' + ctx.period + ' 期租金', lines.join('\n\n'), ctx.turn);
}

/** 第一次买到辣椒时，教精华怎么用（chili_powder_essence_prompt） */
export function chiliEssenceMail(essenceTokens: number, turn: number): Mail {
  return mail(
    'chili_powder_essence_prompt',
    FROM_HOUSE,
    `关于 ${tagOf('chili_powder')}`,
    [
      `你已获得 ${tagOf('chili_powder')}。`,
      `当前持有 ${essenceTokens} 枚精华代币，可将其升级为 ${tagOf('chili_powder_essence')}。`,
      '在道具栏中点击该道具图标，选择「精华化」即可完成升级。',
    ].join('\n\n'),
    turn,
  );
}

/** 第一次拿到移除代币时的用法说明（removal_token_prompt） */
export function removalTipMail(cost: number, turn: number): Mail {
  return mail(
    'removal_token_prompt',
    FROM_HOUSE,
    '移除代币的用法',
    [
      `点击顶部的移除按钮进入移除模式，再点击棋盘上的任意符号即可将其删除，每次消耗 ${cost} 枚代币。`,
      `例如 ${tagOf('cat')} 只提高自身数值、对相邻符号没有加成，占用格子却不参与协同，删除通常优于保留。`,
      '被删除的符号会同时移出符号池，此后不会再被抽到。',
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
    ctx.endless ? '租金继续上调' : `第 ${ctx.period + 1} 期租金`,
    [
      `第 ${ctx.period} 期租金已结清。下一期租金 ${ctx.nextRent}，本期旋转次数增加 ${ctx.spinsGain} 次。`,
      ctx.endless
        ? '无尽模式没有终点：租金持续上涨，直至无法支付为止。'
        : '租金逐期递增，请注意保持每转产出同步增长。',
    ].join('\n\n'),
    ctx.turn,
  );
}

/** 开局：房东的第一封信（原版 intro） */
export function introMail(mode: 'normal' | 'sandbox' | 'endless', turn: number): Mail {
  const lines = [
    '租约规则如下：每期须先付清当期租金，未付清即视为终止。',
    '每转按符号面板值结算产出；付清租金后可免费选取一个符号或道具放入牌库。',
    '产出沿相邻关系传播，落位由旋转决定，无法手动摆放；同一格相邻的加成符号越多，收益越高。',
  ];
  if (mode === 'sandbox') {
    lines.push(
      '沙盒模式从第 12 期开始，初始金币 999,999，并另附重掷、移除、精华代币各 3 枚，供自由试验。付租会继续推进期数，并解锁更高的楼层档位。',
    );
  } else if (mode === 'endless') {
    lines.push('无尽模式没有第 12 期的终点，租金持续上涨，直至你无法支付。');
  } else {
    lines.push('付清全部 12 期租金后，租约即告完成。届时我会另行通知。');
  }
  lines.push('后续通知会投递到顶部的信箱，请注意查收。');
  return mail('intro', FROM_LANDLORD, '租约说明', lines.join('\n\n'), turn);
}

/** 房东倒下后的收尾信（ending） */
export function endingMail(ctx: { rent: number; totalEarned: number; turn: number }): Mail {
  return mail(
    'ending',
    FROM_LANDLORD,
    '租约终止',
    [
      `最后一期租金 ${ctx.rent}，本局累计产出 ${ctx.totalEarned}。`,
      '我已无法继续追加条款，这栋楼交由你处置。本局成绩与统计已写入本地存档。',
    ].join('\n\n'),
    ctx.turn,
  );
}

/** 房东亲自下场（官方 id：boss_fight_1，Pop-up__Pop-up.gd:560-570） */
export function bossMail(hp: number, turn: number): Mail {
  return mail(
    'boss_fight_1',
    FROM_LANDLORD,
    '最终结算',
    [
      '12 期租金已全部付清，按租约最后一节，由我与你直接结算。',
      `我的生命值 ${hp}。此次结算结束后，本局方才成立。`,
    ].join('\n\n'),
    turn,
  );
}

/** 战斗规则（官方 id：boss_fight_2，Pop-up__Pop-up.gd:605-615） */
export function bossFightMail2(hp: number, turn: number): Mail {
  return mail(
    'boss_fight_2',
    FROM_LANDLORD,
    '结算规则',
    [
      `我的生命值 ${hp}，并且会随回合推进持续提高。`,
      '每转产出的金币同时计入对我造成的伤害，不会留在你的账户里；租金仍需照付，未能支付即告结束。',
      '将我的生命值降至 0，这栋楼归你。',
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
  const lines = [`细则 #${ctx.num}「${ctx.name ?? `细则 ${ctx.num}`}」自下一转起生效。`];
  if (ctx.values.length > 0) lines.push(`本条数值：${ctx.values.join(' / ')}。`);
  if (ctx.dynamicIcon) lines.push(`指定符号：${tagOf(ctx.dynamicIcon)}。`);
  lines.push('细则无需操作，会自动叠入结算；如需查看当前生效的全部条目，点开细则列表。');
  return mail('fine_print', FROM_LANDLORD, `细则 #${ctx.num}`, lines.join('\n\n'), ctx.turn);
}

/** 付清 12 期（原版邮件 kind：win）：房东还没认输，但欠条已经付完一轮 */
export function winMail(ctx: { period: number; rent: number; totalEarned: number; turn: number }): Mail {
  return mail(
    'win',
    FROM_LANDLORD,
    '12 期租金已付清',
    [
      `第 ${ctx.period} 期租金 ${ctx.rent} 已结清，按租约你已具备接手资格。`,
      `本局累计产出 ${ctx.totalEarned}。在交接之前，我会亲自与你结算一次。`,
    ].join('\n\n'),
    ctx.turn,
  );
}

/** 第一次买到道具：介绍道具栏（原版邮件 kind：inventory） */
export function inventoryMail(turn: number): Mail {
  return mail(
    'inventory',
    FROM_HOUSE,
    '道具栏说明',
    [
      '道具不进入牌库，买下后立即生效，并在本局内持续保留。',
      '同一种道具重复购买会叠层（显示为 ×2、×3），层数越高效果越强。',
      '精华代币可将道具升级为精华版：在道具栏点击道具图标，选择「精华化」。付租时未使用的精华代币不会保留。',
    ].join('\n\n'),
    turn,
  );
}

/** 破产（game_over） */
export function gameOverMail(ctx: { period: number; rent: number; coins: number; turn: number }): Mail {
  return mail(
    'game_over',
    FROM_LANDLORD,
    '租约终止',
    [
      `第 ${ctx.period} 期租金 ${ctx.rent}，你的金币为 ${ctx.coins}，未能支付。`,
      '精华代币在付租时会失效，建议尽早使用。',
    ].join('\n\n'),
    ctx.turn,
  );
}
