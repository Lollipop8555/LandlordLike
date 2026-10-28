/**
 * 精华的卡片文案。
 *
 * 精华在原版是「对应道具的强化版」：拿到它就把同名道具换掉，效果触发一次就消耗，
 * 消耗那一刻再结算一份永久加成。数据里这条链路被拆成两条技术声明：
 *
 *   {symbol_trigger: true} → destroyed = true           （用一次就没了）
 *   {destroyed: true}      → permanent_bonuses = {...}  （消耗时给一整类符号加永久）
 *
 * 直接丢给通用规则渲染，第二句掉进空文案，第一句变成「被其他符号触发过时，摧毁自己」——
 * 玩家读到的是「这卡有什么毛病」，而不是「它强化了什么」。所以精华单独走这一层措辞。
 */
import { ITEM_BY_ID, SYMBOL_BY_ID } from './data';
import { describeRule, rulesOf } from './effects';
import { symbolName } from './names';
import { isItemUnimplemented } from './unimplemented';
import type { EffectComparison, EffectRule, SymbolDef } from './types';

/** 精华都是一次性消耗品，id 以 `_essence` 结尾 */
export function isEssence(id: string): boolean {
  return id.endsWith('_essence');
}

/** 它强化的是哪件道具（去掉后缀）；原版里没有同名道具的精华也能买，返回空 */
export function essenceBaseId(id: string): string | null {
  if (!isEssence(id)) return null;
  const base = id.slice(0, -'_essence'.length);
  return ITEM_BY_ID.has(base) || SYMBOL_BY_ID.has(base) ? base : null;
}

function defOf(id: string): SymbolDef | undefined {
  return ITEM_BY_ID.get(id) ?? SYMBOL_BY_ID.get(id);
}

/** 规则的条件里直接写了 `destroyed` —— 这些句子的前提是「这份精华已经被消耗」 */
function waitDestroyed(rule: EffectRule): boolean {
  return rule.comparisons.some((c: EffectComparison) => c.a === 'destroyed');
}

/** 条件里的 `symbol_trigger: true` —— 精华自己的效果被触发过一次 */
function waitTrigger(rule: EffectRule): boolean {
  return rule.comparisons.some((c: EffectComparison) => c.a === 'symbol_trigger');
}

/** 值型声明的开头（"数值变为 77"），句子已经丢了主语，补成「自身…」 */
const VALUE_HEADS = /^(数值|积累|本轮倍率|永久倍率|额外数值|额外倍率|移除代币|重摇次数)/;

/** 消耗门槛写成动态读数时的说法（`a` 为空、只有 dynamic_a_key） */
const DYN_LABEL: Record<string, string> = {
  symbols_destroyed_this_spin: '本转被摧毁的符号数',
  removal_tokens: '移除代币数',
};

/**
 * 通用渲染的一批措辞是给「棋盘上的符号」写的，摆在精华卡上要换掉主语并去掉
 * 只对道具卡有意义的补充（句末「（消耗X精华）」——消耗由最后一句统一交代）。
 */
function polish(text: string): string {
  return text
    .replace(/^本符号被摧毁时，/, '')
    .replace(/^被其他符号触发过时，/, '')
    .replace(/^本符号/, '自身')
    .replace(/本符号/g, '自身')
    .replace(/场上有(.+?)时，/g, '只要$1在场，')
    // 与末句「累积达到 N 后消耗」用同一个词
    .replace(/积累/g, '累积')
    .replace(/（消耗[^）]*精华）$/, '')
    .trim();
}

/** `{$self_index:N}` 这类占位取值换算成这张卡的实际数值 */
function slotValue(raw: unknown, def: SymbolDef | undefined): number | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'object' && raw !== null) {
    const idx = (raw as { $self_index?: number }).$self_index;
    if (typeof idx === 'number') return def?.values?.[idx] ?? null;
    const direct = (raw as { $dyn?: unknown }).$dyn;
    if (typeof direct === 'number') return direct;
  }
  return null;
}

/**
 * 精华卡片的正文：先说是谁的强化版，再列收益，最后一句交代消耗。
 * 收益句沿用通用渲染（permanent_bonuses 已补上文案），只把「已被摧毁」翻成「消耗时」。
 */
export function essenceLines(id: string): string[] {
  const def = defOf(id);
  const owner = def ? { id: def.id, values: def.values ?? [] } : undefined;
  const rules = rulesOf(id);
  const lines: string[] = [];

  const baseId = essenceBaseId(id);
  const base = baseId ? symbolName(baseId) : '';
  lines.push(base ? `《${base}》的强化版：买下即替换手里的同名道具` : '强化版道具：不占棋盘格');

  const gains: string[] = [];
  for (const rule of rules) {
    // 消耗本身由最后一句统一交代，不逐条念技术声明
    if (rule.vtc === 'destroyed') continue;
    const text = describeRule(rule, owner);
    if (!text) continue;
    // 通用渲染的前缀是给「别的符号」写的（本符号被摧毁时 / 被其他符号触发过时），
    // 在精华卡上换成它自己的说法，否则读起来像在描述别人
    const clean = polish(text);
    const body = VALUE_HEADS.test(clean) ? `自身${clean}` : clean;
    const line = waitDestroyed(rule)
      ? `消耗时，${body}`
      : waitTrigger(rule)
        ? `触发时，${body}`
        : body;
    if (!gains.includes(line)) gains.push(line);
  }
  if (gains.length > 0) {
    lines.push(...gains);
  } else if (base) {
    // 这 35 张的强化写在原版脚本的触发逻辑里，数据表没有可读声明。
    // 不编造没抓到的数值：原道具本身也没还原的，就直接把话说白。
    lines.push(
      baseId && isItemUnimplemented(baseId)
        ? `⚠ 强化效果还没还原：《${base}》本身的玩法也在补，目前只做到「换掉同名道具」`
        : `强化细节沿用《${base}》：同一套规则，区别只在它会被消耗`,
    );
  }

  // 消耗条件：触发一次 / 攒够 N 次 / 立刻 / 其它
  // 有的精华既会被「触发一次」吃掉，也有一条攒够 N 次的声明（开锁器）：
  // 优先挑写到计数的那个，玩家才知道自己还有几次
  const burns = rules.filter((r) => r.vtc === 'destroyed');
  const burn =
    burns.find((r) => r.comparisons.some((c: EffectComparison) => c.a === 'saved_value')) ?? burns[0];
  if (!burn) {
    lines.push('一次性消耗品：结算一次后从道具栏消失');
  } else if (waitTrigger(burn)) {
    lines.push('触发一次后消耗');
  } else if (burn.comparisons.length === 0) {
    lines.push('使用后立即消耗');
  } else {
    // 门槛可能写在 saved_value / values 上，也可能是一句动态读数
    // （堆肥精华：本转被摧毁的符号数 ≥ values[1]）
    const cands = burn.comparisons
      .map((c: EffectComparison) => ({ c, need: slotValue(c.b, def) }))
      .filter((x) => x.need !== null);
    const pick =
      cands.find((x) => x.c.a === 'saved_value') ??
      cands.find((x) => x.c.a === 'values' || x.c.a === 'value') ??
      cands[0];
    const dynKey = pick?.c.dynamic_a_key;
    const label =
      pick?.c.a === 'saved_value'
        ? '累积'
        : pick?.c.a === 'values' || pick?.c.a === 'value'
          ? '数值'
          : typeof dynKey === 'string'
            ? (DYN_LABEL[dynKey] ?? '条件值')
            : '条件值';
    lines.push(pick ? `${label}达到 ${pick.need} 后消耗` : '条件满足后消耗');
  }

  return lines;
}
