import type { GameState } from '../engine';
import type { Profile } from './save';

/** 触发成就检查的事件（由引擎在关键节点发出） */
export type AchEvent =
  | {
      t: 'spin';
      output: number;
      destroyed: number;
      negative: number;
      /** 本转被摧毁的符号与凶手（state.lastKills），原版 destroyed_or_removed_by 的等价物 */
      kills: Array<{ id: string; by?: string }>;
      /** 本转 tiles_to_add 生成出来的符号（state.lastSpawned） */
      spawned: string[];
    }
  | { t: 'rent'; paid: number }
  | { t: 'buy'; stacks: number }
  | { t: 'boss'; damage: number }
  | { t: 'essence'; id: string }
  | { t: 'end'; won: boolean }
  /** 棋盘上的彩蛋互动（撸狗、逗兔子）：只喂统计类成就 */
  | { t: 'pet'; who: string };

export interface AchContext {
  state: GameState;
  event: AchEvent;
  profile: Profile;
}

export interface Achievement {
  id: string;
  icon: string;
  name: string;
  desc: string;
  /** 隐藏成就：解锁前只显示轮廓 */
  hidden?: boolean;
  check: (ctx: AchContext) => boolean;
}

const itemCount = (s: GameState): number => s.items.reduce((n, it) => n + it.count, 0);
const symbolCount = (s: GameState): number => s.pool.length;
const maxStack = (s: GameState): number => s.items.reduce((n, it) => Math.max(n, it.count), 0);
const paid = (c: AchContext): number => c.state.rentPaid;
/** 已精华化的道具层数（精华版 id 一律以 _essence 结尾） */
const essenceCount = (s: GameState): number =>
  s.items.reduce((n, it) => n + (it.def.id.endsWith('_essence') ? it.count : 0), 0);
/** 最后一转里最贵的那个格子，用来判断"单个符号能打多少" */
const bestFinal = (s: GameState): number => s.lastFinals.reduce((m, v) => Math.max(m, v), 0);

/* ── 本转事件 ── */
const killsOf = (c: AchContext): Array<{ id: string; by?: string }> =>
  c.event.t === 'spin' ? c.event.kills : [];
const spawnedOf = (c: AchContext): string[] => (c.event.t === 'spin' ? c.event.spawned : []);
/** 某个符号被某个凶手摧毁（原版 target.destroyed_or_removed_by.has(killer)） */
const killedBy = (c: AchContext, victim: string, killer: string): boolean =>
  killsOf(c).some((k) => k.id === victim && k.by === killer);
const spawnedAny = (c: AchContext, ids: string[]): boolean => spawnedOf(c).some((id) => ids.includes(id));

/* ── 牌面事实 ── */
const countOf = (s: GameState, id: string): number => s.pool.filter((d) => d.id === id).length;
const uniqueSymbols = (s: GameState): number => new Set(s.pool.map((d) => d.id)).size;
const rarityCount = (s: GameState, rarity: string): number =>
  s.pool.filter((d) => d.rarity === rarity).length;

export const ACHIEVEMENTS: Achievement[] = [
  // —— 租金进度 ——
  { id: 'rent_1', icon: '🔑', name: '第一次交租', desc: '付清第 1 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 1 },
  { id: 'rent_3', icon: '🏠', name: '站稳脚跟', desc: '付清第 3 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 3 },
  { id: 'rent_6', icon: '🏢', name: '租客的逆袭', desc: '付清第 6 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 6 },
  { id: 'rent_9', icon: '🌆', name: '顶楼风景', desc: '付清第 9 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 9 },
  { id: 'rent_12', icon: '🏆', name: '幸运房东', desc: '付清全部 12 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 12 },

  // —— 结局 ——
  { id: 'clear_normal', icon: '🎉', name: '自由身', desc: '在普通模式通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.mode === 'normal' },
  { id: 'bankrupt', icon: '💸', name: '被赶出门', desc: '因付不起租金破产', check: (c) => c.event.t === 'end' && !c.event.won && c.state.mode !== 'sandbox' },
  { id: 'boss_win', icon: '👊', name: '反客为主', desc: '击败房东本人', check: (c) => c.event.t === 'boss' && c.state.boss !== null && c.state.boss.hp <= 0 },

  // —— 经济 ——
  { id: 'coin_500', icon: '💰', name: '小有积蓄', desc: '在付租前攒到 500 金币', check: (c) => c.event.t === 'rent' && c.state.totalEarned >= 500 },
  { id: 'coin_1500', icon: '🤑', name: '暴发户', desc: '在付租前攒到 1500 金币', check: (c) => c.event.t === 'rent' && c.state.totalEarned >= 1500 },
  { id: 'coin_5000', icon: '🏦', name: '现金为王', desc: '累计产出达到 5000', check: (c) => c.event.t === 'rent' && c.state.totalEarned >= 5000 },
  { id: 'earn_10000', icon: '💎', name: '财源滚滚', desc: '累计产出达到 10000', check: (c) => c.event.t === 'rent' && c.state.totalEarned >= 10000 },
  { id: 'spin_50', icon: '⚡', name: '手气不错', desc: '单次旋转产出 50 金币', check: (c) => c.event.t === 'spin' && c.event.output >= 50 },
  { id: 'spin_100', icon: '🌩️', name: '一发入魂', desc: '单次旋转产出 100 金币', check: (c) => c.event.t === 'spin' && c.event.output >= 100 },
  { id: 'spin_200', icon: '☄️', name: '失控的组合', desc: '单次旋转产出 200 金币', check: (c) => c.event.t === 'spin' && c.event.output >= 200 },

  // —— 组合 ——
  { id: 'symbol_10', icon: '🧩', name: '初具规模', desc: '棋盘上同时有 10 个符号', check: (c) => symbolCount(c.state) >= 10 },
  { id: 'symbol_16', icon: '🧱', name: '满满当当', desc: '棋盘上同时有 16 个符号', check: (c) => symbolCount(c.state) >= 16 },
  { id: 'symbol_20', icon: '🌈', name: '满编阵容', desc: '棋盘上同时有 20 个符号', check: (c) => symbolCount(c.state) >= 20 },
  { id: 'destroy_1', icon: '💥', name: '第一滴血', desc: '让一个符号被摧毁', check: (c) => c.event.t === 'spin' && c.event.destroyed >= 1 },
  { id: 'destroy_10', icon: '🔥', name: '拆迁队', desc: '累计摧毁 10 个符号', check: (c) => c.state.destroyed >= 10 },
  { id: 'negative', icon: '🕳️', name: '负负得正', desc: '在场上放下负数符号', check: (c) => c.event.t === 'spin' && c.event.negative >= 1 },

  // —— 道具 ——
  { id: 'item_1', icon: '🛍️', name: '第一件道具', desc: '购买第一件道具', check: (c) => c.event.t === 'buy' && itemCount(c.state) >= 1 },
  { id: 'item_4', icon: '🎒', name: '背包初具', desc: '同时持有 4 件道具', check: (c) => c.event.t === 'buy' && itemCount(c.state) >= 4 },
  { id: 'item_8', icon: '🧳', name: '满载而归', desc: '同时持有 8 件道具', check: (c) => c.event.t === 'buy' && itemCount(c.state) >= 8 },
  { id: 'item_12', icon: '🚚', name: '搬家现场', desc: '同时持有 12 件道具', check: (c) => c.event.t === 'buy' && itemCount(c.state) >= 12 },
  { id: 'stack_3', icon: '📚', name: '囤货癖', desc: '同一种道具叠到 3 层', check: (c) => c.event.t === 'buy' && maxStack(c.state) >= 3 },
  { id: 'buy_10', icon: '🧾', name: '老主顾', desc: '一局内购买 10 次', check: (c) => c.event.t === 'buy' && c.state.buys >= 10 },

  // —— 模式 ——
  { id: 'endless_15', icon: '🛫', name: '超出合同', desc: '无尽模式付清第 15 期租金', check: (c) => c.event.t === 'rent' && c.state.mode === 'endless' && paid(c) >= 15 },
  { id: 'endless_20', icon: '🌌', name: '无休止的旋转', desc: '无尽模式付清第 20 期租金', check: (c) => c.event.t === 'rent' && c.state.mode === 'endless' && paid(c) >= 20 },
  { id: 'sandbox_spin_100', icon: '🧪', name: '实验室常客', desc: '沙盒模式旋转 100 次', check: (c) => c.state.mode === 'sandbox' && c.state.totalSpins >= 100 },

  // —— Boss ——
  { id: 'boss_start', icon: '🚪', name: '敲开房东的门', desc: '进入房东之战', check: (c) => c.state.boss !== null && c.state.boss.active },
  { id: 'boss_damage_300', icon: '🩸', name: '重创', desc: '对房东累计造成 300 伤害', check: (c) => c.state.boss !== null && c.state.boss.maxHp - c.state.boss.hp >= 300 },
  { id: 'boss_damage_600', icon: '💣', name: '过半', desc: '对房东累计造成 600 伤害', check: (c) => c.state.boss !== null && c.state.boss.maxHp - c.state.boss.hp >= 600 },

  // —— 档案 ——
  { id: 'run_5', icon: '📖', name: '屡败屡战', desc: '累计开局 5 次', check: (c) => c.profile.stats.runs >= 5 },
  { id: 'run_20', icon: '🗂️', name: '老租客', desc: '累计开局 20 次', check: (c) => c.profile.stats.runs >= 20 },
  { id: 'win_3', icon: '👑', name: '三连房东', desc: '累计通关 3 次', check: (c) => c.profile.stats.wins >= 3 },
  { id: 'spins_300', icon: '🎰', name: '肌肉记忆', desc: '累计旋转 300 次', check: (c) => c.profile.stats.totalSpins >= 300 },

  // —— 单转表现 ——
  { id: 'tile_100', icon: '💯', name: '百元符号', desc: '单个符号在一转里产出 100', check: (c) => c.event.t === 'spin' && bestFinal(c.state) >= 100 },
  { id: 'tile_500', icon: '🌀', name: '乘数黑洞', desc: '单个符号在一转里产出 500', check: (c) => c.event.t === 'spin' && bestFinal(c.state) >= 500 },
  { id: 'spin_500', icon: '🌠', name: '天文数字', desc: '单次旋转产出 500 金币', hidden: true, check: (c) => c.event.t === 'spin' && c.event.output >= 500 },
  { id: 'spin_negative', icon: '🕳️', name: '倒贴', desc: '一整转产出居然是负数', hidden: true, check: (c) => c.event.t === 'spin' && c.event.output < 0 },
  { id: 'chain_blast', icon: '🧨', name: '连锁爆破', desc: '一转里摧毁 5 个符号', check: (c) => c.event.t === 'spin' && c.event.destroyed >= 5 },
  { id: 'destroy_50', icon: '🏗️', name: '拆迁队长', desc: '累计摧毁 50 个符号', check: (c) => c.state.destroyed >= 50 },

  // —— 付租技巧 ——
  { id: 'coins_2000', icon: '🏛️', name: '现金堆成山', desc: '付租时手里还压着 2000 金币', check: (c) => c.event.t === 'rent' && c.state.coins >= 2000 },
  { id: 'last_coin', icon: '🪙', name: '压线付租', desc: '付完租只剩 20 金币以内', hidden: true, check: (c) => c.event.t === 'rent' && c.state.coins <= 20 },
  { id: 'no_item_win', icon: '🥊', name: '赤手空拳', desc: '一件道具都没买就通过一层', hidden: true, check: (c) => c.event.t === 'end' && c.event.won && c.state.items.length === 0 },

  // —— 道具与精华 ——
  { id: 'item_20', icon: '🏬', name: '收藏成癖', desc: '同时持有 20 件道具', check: (c) => itemCount(c.state) >= 20 },
  { id: 'stack_5', icon: '📦', name: '批发价', desc: '同一种道具叠到 5 层', check: (c) => maxStack(c.state) >= 5 },
  { id: 'essence_1', icon: '✨', name: '精华初体验', desc: '把一件道具精华化', check: (c) => c.event.t === 'essence' || essenceCount(c.state) >= 1 },
  { id: 'essence_4', icon: '🔮', name: '全身精华', desc: '持有 4 件精华道具', check: (c) => essenceCount(c.state) >= 4 },

  // —— 细则 ——
  { id: 'fine_1', icon: '📜', name: '第一条规矩', desc: '吃到第一条房东细则', check: (c) => c.state.finePrints.length >= 1 },
  { id: 'fine_8', icon: '🗂️', name: '规矩成山', desc: '一局里堆到 8 条细则', check: (c) => c.state.finePrints.length >= 8 },

  // —— 楼层与模式 ——
  { id: 'floor_3', icon: '🪜', name: '往上爬', desc: '通关第 3 层', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor >= 3 },
  { id: 'floor_10', icon: '🏙️', name: '爬到半山', desc: '通关第 10 层', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor >= 10 },
  { id: 'floor_20', icon: '🌃', name: '顶楼住户', desc: '通关第 20 层', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor >= 20 },
  { id: 'endless_30', icon: '🌌', name: '三十期之后', desc: '无尽模式付清第 30 期', check: (c) => c.event.t === 'rent' && c.state.mode === 'endless' && paid(c) >= 30 },

  // —— 长期档案 ——
  { id: 'run_50', icon: '🏚️', name: '常住户', desc: '累计开局 50 次', check: (c) => c.profile.stats.runs >= 50 },
  { id: 'win_10', icon: '🎖️', name: '房东克星', desc: '累计通关 10 次', check: (c) => c.profile.stats.wins >= 10 },
  { id: 'spins_1000', icon: '🕰️', name: '千转', desc: '累计旋转 1000 次', check: (c) => c.profile.stats.totalSpins >= 1000 },

  // —— 逐层通关 ——
  // 原版把 20 层各做成一条成就（Stats.gd:168 的 apartment_floor + 149），
  // 这里同样逐层铺开：层数是开局选定的，所以"在某层通关"就是一条独立里程碑。
  { id: 'floor_1', icon: '🚪', name: '搬进一楼', desc: '在第 1 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 1 },
  { id: 'floor_2', icon: '🪜', name: '二楼住户', desc: '在第 2 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 2 },
  { id: 'floor_4', icon: '🧳', name: '爬到四楼', desc: '在第 4 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 4 },
  { id: 'floor_5', icon: '🌤️', name: '五楼风光', desc: '在第 5 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 5 },
  { id: 'floor_6', icon: '🪟', name: '六楼看街', desc: '在第 6 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 6 },
  { id: 'floor_7', icon: '📮', name: '七楼信箱', desc: '在第 7 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 7 },
  { id: 'floor_8', icon: '🌧️', name: '八楼漏雨', desc: '在第 8 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 8 },
  { id: 'floor_9', icon: '🔧', name: '九楼修水管', desc: '在第 9 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 9 },
  { id: 'floor_11', icon: '🎈', name: '十一楼派对', desc: '在第 11 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 11 },
  { id: 'floor_12', icon: '🕛', name: '十二楼满租', desc: '在第 12 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 12 },
  { id: 'floor_13', icon: '🐈', name: '十三楼猫窝', desc: '在第 13 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 13 },
  { id: 'floor_14', icon: '🌙', name: '十四楼夜班', desc: '在第 14 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 14 },
  { id: 'floor_15', icon: '🧯', name: '十五楼消防', desc: '在第 15 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 15 },
  { id: 'floor_16', icon: '🛗', name: '十六楼电梯', desc: '在第 16 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 16 },
  { id: 'floor_17', icon: '☁️', name: '十七楼云上', desc: '在第 17 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 17 },
  { id: 'floor_18', icon: '🏙️', name: '十八楼天际线', desc: '在第 18 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 18 },
  { id: 'floor_19', icon: '🌠', name: '十九楼观星', desc: '在第 19 层通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.floor === 19 },

  // —— 生成（tiles_to_add）——
  // 原版这类成就挂在「某符号产出了某物」上（Slot_Icon 里 milk/honey/spirit 的 add_queued_achievement），
  // 现在引擎把生成记进 lastSpawned，终于能判定。
  { id: 'spawn_first', icon: '🌱', name: '无中生有', desc: '一转里生成出第一个符号', check: (c) => spawnedOf(c).length >= 1 },
  { id: 'spawn_5', icon: '🌾', name: '一窝五个', desc: '一转里生成 5 个符号', check: (c) => spawnedOf(c).length >= 5 },
  {
    id: 'spawn_unique_3',
    icon: '🎰',
    name: '种类齐全',
    desc: '一转里生成 3 种不同符号',
    check: (c) => new Set(spawnedOf(c)).size >= 3,
  },
  { id: 'spawn_milk', icon: '🥛', name: '现挤的', desc: '让牛产出牛奶', check: (c) => spawnedAny(c, ['milk']) },
  { id: 'spawn_honey', icon: '🍯', name: '蜂巢出品', desc: '让蜂巢产出蜂蜜', check: (c) => spawnedAny(c, ['honey']) },
  { id: 'spawn_spirit', icon: '👻', name: '墓地的回音', desc: '让墓碑召唤出灵魂', check: (c) => spawnedAny(c, ['spirit']) },
  { id: 'spawn_golden_egg', icon: '🥚', name: '金蛋', desc: '让金鹅下出金蛋', check: (c) => spawnedAny(c, ['golden_egg']) },
  { id: 'spawn_ore', icon: '⛏️', name: '挖到东西了', desc: '让矿产出矿石', check: (c) => spawnedAny(c, ['ore']) },
  {
    id: 'spawn_rewind',
    icon: '⏳',
    name: '倒带',
    desc: '时间胶囊把本转被摧毁的符号吐回来',
    hidden: true,
    check: (c) => killsOf(c).some((k) => spawnedOf(c).includes(k.id)),
  },

  // —— 符号互动（原版 destroyed_or_removed_by 系成就）——
  { id: 'cat_milk', icon: '🐱', name: '猫喝到奶了', desc: '让猫摧毁一份牛奶', check: (c) => killedBy(c, 'milk', 'cat') },
  { id: 'bear_honey', icon: '🐻', name: '熊找到蜜了', desc: '让熊摧毁一份蜂蜜', check: (c) => killedBy(c, 'honey', 'bear') },
  {
    id: 'peel_thief',
    icon: '🍌',
    name: '小偷滑倒了',
    desc: '让香蕉皮摧毁一个小偷',
    check: (c) => killedBy(c, 'thief', 'banana_peel'),
  },
  {
    id: 'coconut_split',
    icon: '🥥',
    name: '砸开椰子',
    desc: '让椰子被摧毁',
    check: (c) => killsOf(c).some((k) => k.id === 'coconut'),
  },

  // —— 牌面构成 ——
  { id: 'unique_8', icon: '🎨', name: '八仙过海', desc: '棋盘上同时有 8 种不同符号', check: (c) => uniqueSymbols(c.state) >= 8 },
  { id: 'unique_12', icon: '🧬', name: '基因多样', desc: '棋盘上同时有 12 种不同符号', check: (c) => uniqueSymbols(c.state) >= 12 },
  { id: 'full_25', icon: '🧱', name: '一个空位都没有', desc: '25 个槽位全部占满', check: (c) => symbolCount(c.state) >= 25 },
  { id: 'five_same', icon: '🖐️', name: '五胞胎', desc: '同一种符号同时在场 5 个', check: (c) => c.state.pool.some((d) => countOf(c.state, d.id) >= 5) },
  { id: 'rare_pair', icon: '🔷', name: '稀有双全', desc: '场上同时有 2 个稀有符号', check: (c) => rarityCount(c.state, 'rare') >= 2 },
  { id: 'very_rare', icon: '🔶', name: '极稀有收藏家', desc: '场上出现极稀有符号', check: (c) => rarityCount(c.state, 'very_rare') >= 1 },

  // —— 规模与统计 ——
  { id: 'spin_1000', icon: '🌋', name: '千元一转', desc: '单次旋转产出 1000 金币', hidden: true, check: (c) => c.event.t === 'spin' && c.event.output >= 1000 },
  { id: 'earn_20000', icon: '🏰', name: '一条街的租金', desc: '本局累计产出达到 20000', check: (c) => c.state.totalEarned >= 20000 },
  { id: 'rum_5000', icon: '🧮', name: '五千现金', desc: '付租时手里压着 5000 金币', check: (c) => c.event.t === 'rent' && c.state.coins >= 5000 },
  { id: 'spins_2000', icon: '⏱️', name: '两千转', desc: '累计旋转 2000 次', check: (c) => c.profile.stats.totalSpins >= 2000 },
  { id: 'spins_5000', icon: '🗿', name: '五千转', desc: '累计旋转 5000 次', check: (c) => c.profile.stats.totalSpins >= 5000 },
  { id: 'runs_100', icon: '🧟', name: '一百次重来', desc: '累计开局 100 次', check: (c) => c.profile.stats.runs >= 100 },
  { id: 'wins_25', icon: '🏅', name: '通关机器', desc: '累计通关 25 次', check: (c) => c.profile.stats.wins >= 25 },
  { id: 'bosses_10', icon: '🥊', name: '十次教训房东', desc: '累计击败房东 10 次', check: (c) => c.profile.stats.bosses >= 10 },

  // —— 信箱 ——
  { id: 'mail_1', icon: '📬', name: '有你的信', desc: '收到第一封信', check: (c) => c.state.mails.length >= 1 },
  { id: 'mail_8', icon: '📮', name: '信箱塞满了', desc: '信箱里同时有 8 封以上的信', check: (c) => c.state.mails.length >= 8 },

  // —— 细则 ——
  { id: 'fine_3', icon: '📑', name: '三条规矩', desc: '一局里堆到 3 条细则', check: (c) => c.state.finePrints.length >= 3 },
  { id: 'fine_12', icon: '📕', name: '整整一页', desc: '一局里堆到 12 条细则', hidden: true, check: (c) => c.state.finePrints.length >= 12 },

  // —— 模式与挑战 ——
  { id: 'endless_40', icon: '🌌', name: '四十期以外', desc: '无尽模式付清第 40 期', check: (c) => c.event.t === 'rent' && c.state.mode === 'endless' && paid(c) >= 40 },
  { id: 'sandbox_full', icon: '🧪', name: '沙盒满盘', desc: '沙盒模式把 25 个槽位摆满', check: (c) => c.state.mode === 'sandbox' && symbolCount(c.state) >= 25 },
  { id: 'boss_no_fine', icon: '🧘', name: '一条规矩都没听', desc: '带着 0 条细则击败房东', hidden: true, check: (c) => c.event.t === 'boss' && c.state.boss !== null && c.state.boss.hp <= 0 && c.state.finePrints.length === 0 },
  { id: 'boss_damage_1000', icon: '☠️', name: '千斤伤害', desc: '对房东累计造成 1000 伤害', check: (c) => c.state.boss !== null && c.state.boss.maxHp - c.state.boss.hp >= 1000 },
  { id: 'floor_20_win', icon: '👑', name: '顶楼的主人', desc: '在第 20 层击败房东', hidden: true, check: (c) => c.event.t === 'boss' && c.state.boss !== null && c.state.boss.hp <= 0 && c.state.floor === 20 },

  // —— 道具与精华（继续铺量）——
  { id: 'item_24', icon: '🏬', name: '道具收藏家', desc: '同时持有 24 件道具', check: (c) => itemCount(c.state) >= 24 },
  { id: 'essence_8', icon: '🔮', name: '八重精华', desc: '持有 8 件精华道具', check: (c) => essenceCount(c.state) >= 8 },
  { id: 'buy_30', icon: '💳', name: '月光族', desc: '一局内购买 30 次', check: (c) => c.event.t === 'buy' && c.state.buys >= 30 },
  { id: 'stack_8', icon: '📦', name: '八层叠加', desc: '同一种道具叠到 8 层', check: (c) => maxStack(c.state) >= 8 },
  { id: 'all_fine', icon: '🗃️', name: '细则收藏', desc: '一局里堆到 20 条细则', hidden: true, check: (c) => c.state.finePrints.length >= 20 },
  { id: 'no_item_win_boss', icon: '🥋', name: '空手道', desc: '一件道具都没有就打赢房东', hidden: true, check: (c) => c.event.t === 'boss' && c.state.boss !== null && c.state.boss.hp <= 0 && c.state.items.length === 0 },

  // —— 彩蛋互动（原版 Stats.gd 的计数器，单位沿用源码）——
  { id: 'pet_dog_hour', icon: '🐕', name: '狗是人类最好的朋友', desc: '累计撸狗 1 小时', hidden: true, check: (c) => c.profile.stats.petDogHours >= 1 },
  { id: 'rabbit_hops', icon: '🐇', name: '一千次弹跳', desc: '累计看到兔子跳 1000 下', check: (c) => c.profile.stats.rabbitHops >= 1000 },
  { id: 'rabbit_fluff', icon: '🧶', name: '一屋子兔毛', desc: '累计收集 3 磅兔毛', check: (c) => c.profile.stats.rabbitFluff >= 3 },
  { id: 'alcohol_50', icon: '🍺', name: '五十加仑', desc: '累计打翻 50 加仑酒', check: (c) => c.profile.stats.alcoholGallons >= 50 },
];

export const ACHIEVEMENT_TOTAL = ACHIEVEMENTS.length;

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function achievementById(id: string): Achievement | undefined {
  return BY_ID.get(id);
}

export function unlockedCount(profile: Profile): number {
  return ACHIEVEMENTS.filter((a) => profile.unlocked[a.id]).length;
}

/** 检查并解锁；返回本次新解锁的成就（供界面弹提示） */
export function checkAchievements(profile: Profile, state: GameState, event: AchEvent): Achievement[] {
  const fresh: Achievement[] = [];
  for (const ach of ACHIEVEMENTS) {
    if (profile.unlocked[ach.id]) continue;
    if (ach.check({ state, event, profile })) {
      profile.unlocked[ach.id] = Date.now();
      fresh.push(ach);
    }
  }
  return fresh;
}
