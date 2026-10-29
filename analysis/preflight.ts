// @ts-nocheck
/**
 * 发布前自检（本地，不入库）：
 *   A 数据链路    data/*.csv → web/src/data/*.json → 前端常量，逐表核对行数与引用闭包
 *   B 引擎不变量  无浏览器跑 N 局，检查金币/池/数值等硬约束
 *   C 交互键位    renderGame 产出的 data-action 是否都有 handler case，反之亦然
 *   D 构建产物    dist 是否自包含、可离线、体积可控
 *
 * 用法（仓库根目录）：
 *   npx esbuild analysis/preflight.ts --bundle --platform=node --format=esm \
 *     --outfile=analysis/.build/preflight.mjs --log-level=warning && node analysis/.build/preflight.mjs
 *
 * 退出码：有任一 FAIL 则为 1。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  ESSENCES,
  EFFECTS,
  EFFECTS_NATIVE,
  FINE_PRINT,
  ITEM_POOL,
  ITEMS,
  PLACEABLES,
  RARITY_TABLE,
  RENT_TABLE,
  SHOP_SYMBOLS,
  SYMBOL_POOL,
  SYMBOLS,
  symbol,
} from '../web/src/data';
import { applyItemEffects, symbolCoverage } from '../web/src/effects';
import { essenceLines, isEssence } from '../web/src/essence-notes';
import { UNIMPLEMENTED_ITEMS, UNIMPLEMENTED_SYMBOLS } from '../web/src/unimplemented';
import { emojiOf } from '../web/src/sprites';
import {
  applySymbolRemovalItems,
  beginSpin,
  bossRent,
  buyFromShop,
  closeShop,
  canRespinReel,
  createCell,
  createGame,
  dealBossDamage,
  essenceUpgrade,
  isItemDef,
  landlordMaxHp,
  markMailRead,
  payRent,
  removeSymbolAt,
  emptySlotCount,
  rentFor,
  rentRescueOptions,
  payRentWithItem,
  canToggleItem,
  toggleItemEnabled,
  isItemDestroyable,
  rerollShop,
  resolveSpin,
  respinReel,
  spreadWildcardFlatBonus,
  skipSwap,
  spin,
  startBossFight,
  swapSymbols,
  unreadMails,
  visibleCells,
} from '../web/src/engine';
import { comradeValues, tagOf } from '../web/src/mail';
import { CELL_COUNT, COLS, ROWS, SLOTS_PER_REEL } from '../web/src/grid';
import { evaluateCell } from '../web/src/value';
import { runSelfChecks } from '../web/src/selfcheck';

/* ── 基础 ── */

let ROOT = process.cwd();
while (!fs.existsSync(path.join(ROOT, '.gitignore')) && ROOT !== path.dirname(ROOT)) {
  ROOT = path.dirname(ROOT);
}
const DATA = path.join(ROOT, 'data');
const WEB = path.join(ROOT, 'web');

interface Row {
  group: string;
  name: string;
  ok: boolean;
  detail: string;
}
const rows: Row[] = [];
function check(group: string, name: string, ok: boolean, detail = ''): void {
  rows.push({ group, name, ok, detail });
}
function info(group: string, name: string, detail: string): void {
  rows.push({ group, name, ok: true, detail });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** git 风格 glob（够用即可：* 与 **） */
function globMatch(pattern: string, target: string): boolean {
  const re = pattern
    .split('**')
    .map((seg) => seg.split('*').map(escapeRe).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${re}$`).test(target);
}

const ignoreRules = fs
  .readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

/** 返回命中 rel 的忽略规则，未命中返回 null */
function ignoredBy(rel: string): string | null {
  for (const rule of ignoreRules) {
    const r = rule.replace(/^\//, '');
    const dir = r.replace(/\/$/, '');
    if (r.endsWith('/') && (rel === dir || rel.startsWith(`${dir}/`))) return rule;
    if (globMatch(dir, rel)) return rule;
    if (!dir.includes('/') && rel.split('/').some((seg) => globMatch(dir, seg))) return rule;
  }
  return null;
}

/** 极简 CSV 解析，与 web/scripts/gen-data.mjs 同规则 */
function parseCSV(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => r.some((c) => c.trim() !== ''));
}

function csvRows(file: string): string[][] {
  const all = parseCSV(fs.readFileSync(path.join(DATA, file), 'utf8'));
  return all.slice(1);
}

/* ── A. 数据链路 ── */

const TABLES: Array<{ csv: string; json: string; size: number }> = [
  { csv: 'symbols.csv', json: 'symbols.json', size: SYMBOLS.length },
  { csv: 'items.csv', json: 'items.json', size: ITEMS.length },
  { csv: 'essences.csv', json: 'essences.json', size: ESSENCES.length },
  { csv: 'fine_print.csv', json: 'finePrint.json', size: FINE_PRINT.length },
  { csv: 'source_rent.csv', json: 'rent.json', size: RENT_TABLE.length },
  {
    csv: 'source_rarity.csv',
    json: 'rarity.json',
    size: RARITY_TABLE.symbol.length + RARITY_TABLE.item.length,
  },
  // effects.json 是 Slot_Icon.gd 的原始声明（`a|b|c` 未展开）；
  // 道具/精华的声明单独放在 item_effects.csv，由 gen-data 挂到各自 def 上。
  { csv: 'effects.csv', json: 'effects.json', size: EFFECTS_NATIVE.length },
];

for (const t of TABLES) {
  const abs = path.join(DATA, t.csv);
  const exists = fs.existsSync(abs);
  check('A 数据链路', `${t.csv} 存在`, exists, exists ? '' : '缺失，构建会失败');
  if (!exists) continue;

  const hit = ignoredBy(`data/${t.csv}`);
  check(
    'A 数据链路',
    `${t.csv} 未被 gitignore 排除`,
    !hit,
    hit ? `被规则 "${hit.trim()}" 排除，CI 会缺少该表` : '',
  );

  const n = csvRows(t.csv).length;
  check(
    'A 数据链路',
    `${t.csv} 行数 = ${t.json} 长度`,
    n === t.size,
    `csv ${n} vs json ${t.size}`,
  );
}

// 未被任何构建步骤消费的表：可能是遗漏，也可能只给文档用
// item_effects.csv 不单独成 json，由 gen-data 挂到 items/essences 的 def 上。
const consumed = new Set([...TABLES.map((t) => t.csv), 'item_effects.csv']);
const allCsv = fs.readdirSync(DATA).filter((f) => f.endsWith('.csv'));
const orphans = allCsv.filter((f) => !consumed.has(f));
info(
  'A 数据链路',
  '未进入网页的表',
  orphans.length ? `${orphans.join(', ')}（仅供文档/分析，不影响构建）` : '无',
);

// 合规：原作资源与叙事文本只允许留在本地研究目录 analysis/data/（已被 .gitignore 排除），
// 不得出现在构建数据目录 data/ 或产品目录 web/ 中。
const LOCAL_ONLY = ['raw', 'emails.csv'];
for (const name of LOCAL_ONLY) {
  for (const dir of ['data', 'web']) {
    const rel = `${dir}/${name}`;
    check('A 数据链路', `${rel} 不在构建链路`, !fs.existsSync(path.join(ROOT, rel)));
  }
}
for (const rel of ['data/source_index.csv', 'data/symbol_effects.csv']) {
  check('A 数据链路', `${rel} 不在工作区`, !fs.existsSync(path.join(ROOT, rel)));
}
const localDir = path.join(ROOT, 'analysis', 'data');
if (fs.existsSync(localDir)) {
  const localEntries = fs.readdirSync(localDir).sort();
  info(
    'A 数据链路',
    '本地研究材料',
    `${localEntries.join(', ')}（analysis/data/，已忽略，不入库、不参与构建）`,
  );
  const genSrc = fs.readFileSync(path.join(ROOT, 'web/scripts/gen-data.mjs'), 'utf8');
  const genTouchesLocal = genSrc.includes('analysis/data');
  check(
    'A 数据链路',
    'analysis/data/ 不被构建消费',
    !genTouchesLocal,
    genTouchesLocal ? 'gen-data.mjs 指向了本地研究目录' : 'gen-data.mjs 只读 data/',
  );
}

/**
 * 输入可达性：`ruleStatus()` 只回答「这条声明能不能求值」，不回答
 * 「求值依赖的运行时输入是否被 engine 填充」。历史上 `counted_symbols`
 * 与 `times_displayed` 全部通过前者、却因为后者缺失而静默失效
 * （cultist / diamond / watermelon 的同类计数、baron_soap / spirit / bubble
 * 的「产出 N 次后自毁」）。这组断言把「声明引用了某个 ctx 槽位」
 * 与「engine 构造上下文时提供了该槽位」对上。
 */
{
  const engineSrc = fs.readFileSync(path.join(WEB, 'src', 'engine.ts'), 'utf8');

  /** 从 effects.csv 的 comparisons / diff 里提取「读了哪些 ctx 槽位」 */
  const predicates = new Set<string>();
  const ctxSlots = new Set<string>();
  for (const e of EFFECTS) {
    for (const c of e.comparisons) {
      const a = c.a as unknown;
      if (typeof a === 'string') predicates.add(a);
      else if (a && typeof a === 'object' && 'counted_symbols' in (a as object)) {
        predicates.add('counted_symbols');
      }
      if (typeof (c as Record<string, unknown>).dynamic_a_key === 'string') {
        ctxSlots.add(String((c as Record<string, unknown>).dynamic_a_key));
      }
    }
    if (e.flags.some((f) => f.includes('respun'))) ctxSlots.add('respunReel');
  }

  const effectsSrc = fs.readFileSync(path.join(WEB, 'src', 'effects.ts'), 'utf8');
  const valueSrc = fs.readFileSync(path.join(WEB, 'src', 'value.ts'), 'utf8');

  /**
   * 谓词 → 「该槽位必须被写入/读取」的静态证据。
   * 每条给几个候选正则，命中任一条即算提供（因为同一个槽位
   * 在不同文件里由不同写法维护：engine 负责递增、effects 负责读取）。
   */
  const PRED_EVIDENCE: Record<string, Array<[string, RegExp]>> = {
    counted_symbols: [['engine: count 回调', /count:\s*countSymbol/]],
    times_displayed: [
      ['engine: 每转递增', /timesDisplayed\s*=\s*\(cell\.timesDisplayed/],
      ['effects: 读取谓词', /other\.timesDisplayed\s*\?\?/],
      ['effects: 读取表达式', /self\.timesDisplayed\s*\?\?/],
    ],
    times_coins_given: [
      ['engine: 每转递增', /timesCoinsGiven\s*=\s*\(cell\.timesCoinsGiven/],
      ['effects: 读取谓词', /other\.timesCoinsGiven\s*\?\?/],
    ],
    saved_value: [
      ['effects: 读取谓词', /other\.savedValue\s*\?\?/],
      ['engine: 道具 saved_value', /it\.savedValue/],
    ],
    grid_position_x: [['effects: 读 ctx.position.x', /ctx\.position\?\.x/]],
    grid_position_y: [['effects: 读 ctx.position.y', /ctx\.position\?\.y/]],
    drained: [['value.ts: 归零分支', /if \(drained && !historical\)/]],
    wildcarded: [['value.ts: 切换 base', /wcActive/]],
  };

  for (const [pred, evidence] of Object.entries(PRED_EVIDENCE)) {
    if (!predicates.has(pred)) continue;
    const hit = evidence.find(([, re]) =>
      re.test(engineSrc) || re.test(effectsSrc) || re.test(valueSrc),
    );
    check(
      'A 数据链路',
      `输入可达性：${pred} 的上下文已提供`,
      Boolean(hit),
      hit ? hit[0] : `缺少 ${evidence.map(([n]) => n).join(' / ')}`,
    );
  }

  // count 回调必须真的挂在 effectCtx 上
  check(
    'A 数据链路',
    '输入可达性：effectCtx 提供 count 回调',
    /count:\s*countSymbol/.test(engineSrc),
    engineSrc.includes('count: countSymbol') ? '' : 'effectCtx 里没有 count',
  );
  // times_* 必须在每转被递增
  check(
    'A 数据链路',
    '输入可达性：timesDisplayed 每转递增',
    /timesDisplayed\s*=\s*\(cell\.timesDisplayed\s*\?\?\s*0\)\s*\+\s*1/.test(engineSrc),
    engineSrc.includes('(cell.timesDisplayed ?? 0) + 1') ? '' : '没有递增 timesDisplayed',
  );
  check(
    'A 数据链路',
    '输入可达性：timesCoinsGiven 每转递增',
    engineSrc.includes('timesCoinsGiven = (cell.timesCoinsGiven ?? 0) + 1'),
    engineSrc.includes('timesCoinsGiven = (cell.timesCoinsGiven ?? 0) + 1') ? '' : '没有递增 timesCoinsGiven',
  );
}

// 稀有度引用闭包
const rarityKeys = new Set(RARITY_TABLE.symbol.map((r) => r.payment));
const badRarity = SYMBOLS.filter((s) => s.rarity && !['common', 'uncommon', 'rare', 'very_rare'].includes(s.rarity));
check('A 数据链路', '符号稀有度取值合法', badRarity.length === 0, badRarity.slice(0, 3).map((s) => s.id).join(','));

// 效果声明不悬空（`<outside>` = 函数外分支；`a|b` = 多符号共用一条声明）
// 道具也在这张表里，所以用可放置物全集而非纯符号表。
const symbolIds = new Set(PLACEABLES.map((s) => s.id));
const declaredIds = EFFECTS.flatMap((e) => e.symbol.split('|'));
const dangling = declaredIds.filter(
  (id) => id && id !== '<outside>' && !id.startsWith('*') && !symbolIds.has(id),
);
check('A 数据链路', 'effects 声明的符号均存在', dangling.length === 0, [...new Set(dangling)].slice(0, 3).join(','));

const covered = new Set(declaredIds.filter((id) => symbolIds.has(id)));
info('A 数据链路', '有 add_effect 声明的可放置物', `${covered.size} / ${PLACEABLES.length}`);

// 行为未还原清单：既要真的"仍然没行为"，也不能残留在抽取池里，
// 还要保证清单只收有行为证据的符号（纯价值符号不算缺陷）
{
  const byId = new Map(SYMBOLS.map((s) => [s.id, s]));
  const cov = new Map(symbolCoverage().map((r) => [r.id, r]));
  const missing = [...UNIMPLEMENTED_SYMBOLS].filter((id) => !byId.has(id));
  check('A 数据链路', '未还原清单里的符号都存在', missing.length === 0, missing.join(','));

  const resurrected = [...UNIMPLEMENTED_SYMBOLS].filter((id) => (cov.get(id)?.executable ?? 0) > 0);
  check(
    'A 数据链路',
    '未还原清单与实现一致（已补行为就移出清单）',
    resurrected.length === 0,
    resurrected.join(','),
  );

  const drawable = new Set(Object.values(SYMBOL_POOL).flat());
  const leaked = [...UNIMPLEMENTED_SYMBOLS].filter((id) => drawable.has(id));
  check('A 数据链路', '未还原符号不进入抽取池', leaked.length === 0, leaked.join(','));

  // 道具侧对称检查：登记在 UNIMPLEMENTED_ITEMS 里的道具不得出现在商店池
  const itemPool = new Set(Object.values(ITEM_POOL).flat());
  const itemLeak = [...UNIMPLEMENTED_ITEMS].filter((id) => itemPool.has(id));
  check('A 数据链路', '未还原道具不进入抽取池', itemLeak.length === 0, itemLeak.join(','));

  const noEvidence = [...UNIMPLEMENTED_SYMBOLS].filter((id) => {
    const def = byId.get(id);
    if (!def) return false;
    return (def.values ?? []).length === 0 && (def.sfx ?? []).length === 0 && def.value !== 0;
  });
  check(
    'A 数据链路',
    '未还原清单只收有行为证据的符号',
    noEvidence.length === 0,
    noEvidence.join(','),
  );
  info(
    'A 数据链路',
    '可抽取符号',
    `${drawable.size} / ${SHOP_SYMBOLS.length}（${UNIMPLEMENTED_SYMBOLS.size} 张待补行为）`,
  );
}

// 棋盘几何：可视 5 列 × 4 行 = 20 格；每列 5 槽 → 符号池上限 25
check(
  'A 数据链路',
  '可视棋盘 5×4=20 格',
  COLS === 5 && ROWS === 4 && CELL_COUNT === 20,
  `${COLS}×${ROWS}=${CELL_COUNT}`,
);
check(
  'A 数据链路',
  '池上限 = 列数 × 每列槽位',
  SLOTS_PER_REEL === 5 && COLS * SLOTS_PER_REEL === 25,
  `${COLS} × ${SLOTS_PER_REEL} = ${COLS * SLOTS_PER_REEL}`,
);

// 开局可构造（五个基础符号都能在 symbols 表里解析）
let bootOk = true;
let bootMsg = '';
try {
  createGame(1);
} catch (err) {
  bootOk = false;
  bootMsg = String(err);
}
check('A 数据链路', '开局可构造（基础符号齐全）', bootOk, bootMsg);

// 图标全覆盖
const noEmoji = SYMBOLS.filter((s) => !emojiOf(s) || emojiOf(s).trim() === '');
check('A 数据链路', '每个符号都有图标', noEmoji.length === 0, noEmoji.slice(0, 5).map((s) => s.id).join(','));

// 租值单调
const rents = RENT_TABLE.map((r) => r.rent);
const monotonic = rents.every((v, i) => i === 0 || v >= rents[i - 1]);
check('A 数据链路', '租金 12 期单调不减', monotonic && rents.length === 12, rents.join(' → '));

// 稀有度权重归一
const badWeight = [...RARITY_TABLE.symbol, ...RARITY_TABLE.item].filter((r) => {
  const sum = r.common + r.uncommon + r.rare + r.veryRare;
  return Math.abs(sum - 1) > 1e-6;
});
check('A 数据链路', '稀有度权重和为 1', badWeight.length === 0, `${badWeight.length} 行偏差 > 1e-6`);

// 页面内自检（与 docs 数值一一对应）
const sc = runSelfChecks();
const scFail = sc.filter((r) => !r.pass);
check(
  'A 数据链路',
  `页面自检 ${sc.length - scFail.length}/${sc.length}`,
  scFail.length === 0,
  scFail.slice(0, 4).map((r) => `${r.name}(${r.expected}≠${r.actual})`).join(' · '),
);

// 对局页是给玩家看的：不允许把「未实现 / 未还原 / 模型缺口」这类内部措辞当玩法文案。
// 分析页可以谈口径，但也不该再用完成度标签给自己留退路。
const gameSrc = fs.readFileSync(path.join(ROOT, 'web/src/game.ts'), 'utf8');
const viewsSrc = fs.readFileSync(path.join(ROOT, 'web/src/views.ts'), 'utf8');
const jargon = ['未实现', '未还原', '模型缺口', '不支持'];
const gameBad = jargon.filter((w) => gameSrc.includes(w));
const viewsBad = jargon.filter((w) => viewsSrc.includes(w));
check('A 数据链路', '对局页不使用完成度黑话', gameBad.length === 0, gameBad.join(' · ') || 'game.ts');
check('A 数据链路', '分析页不使用完成度黑话', viewsBad.length === 0, viewsBad.join(' · ') || 'views.ts');

/* ── B. 引擎不变量 ── */

interface Run {
  won: boolean;
  over: boolean;
  rounds: number;
  /** 是否打进了房东战（12 期付完即进） */
  boss: boolean;
  issues: string[];
}

function playOnce(seed: number): Run {
  const g = createGame(seed);
  const issues: string[] = [];
  let guard = 0;
  let rounds = 0;

  // 策略：池未满优先补估值最高的符号，池满后补道具位（第 0 张）。
  // 一次商店只能选一张（Pop-up__Pop-up.gd 的选项回调随即关面板）。
  //
  // 注意：付租奖励是**两次连续三选一**（符号 + 道具）。`closeShop` 会自动打开
  // 队列里的下一批，所以这里必须循环到商店真正关闭为止，否则 `shopOpen`
  // 一直为 true，`beginSpin` 会被永久拦下。
  const drainShop = (): void => {
    let guardShop = 0;
    while (g.shopOpen && guardShop < 8) {
      guardShop += 1;
      const filled = g.cells.filter((c) => c.def).length;
      let pick = -1;
      if (filled < CELL_COUNT) {
        for (let i = 0; i < g.shop.length; i += 1) {
          if (isItemDef(g.shop[i].def)) continue;
          if (pick < 0 || g.shop[i].def.value > g.shop[pick].def.value) pick = i;
        }
      }
      if (pick < 0) pick = g.shop.findIndex((c) => isItemDef(c.def));
      if (pick < 0) pick = 0;
      const buyingItem = isItemDef(g.shop[pick].def);
      const buyingToken = Boolean(g.shop[pick].token);
      const before = g.pool.length;
      if (!buyFromShop(g, pick)) {
        // 买不了（例如池满且只有符号）→ 直接跳过这一批
        closeShop(g);
        continue;
      }
      // 代币卡不放进池，只加货币
      if (!buyingItem && !buyingToken && g.pool.length !== before + 1) issues.push('买入后池未增长');
      if (g.pool.length > 25) issues.push(`池超容 ${g.pool.length}`);
      closeShop(g);
    }
  };

  // 12 期普通楼层之后紧接房东战（原版 boss_fight_1），所以这里跑到真正结束为止
  for (let round = 1; round <= 40 && !g.won && !g.over; round += 1) {
    rounds = round;
    while (g.spinsLeft > 0 && !g.won && !g.over) {
      spin(g);
      if (g.coins < 0) issues.push('金币为负');
      if (!Number.isFinite(g.lastSpinOutput)) issues.push('产出非有限');
      if (g.lastFinals.some((v) => !Number.isFinite(v))) issues.push('格子产出非有限');
      const onBoard = g.reels.reduce((n, col) => n + col.filter((c) => c.def).length, 0);
      if (onBoard !== g.pool.length) issues.push(`池不一致 ${onBoard}/${g.pool.length}`);
      drainShop();
      if (++guard > 400) {
        issues.push('旋转未收敛');
        break;
      }
    }
    if (g.won || g.over) break;
    // 付租失败但持有可销毁道具时，`payRent` 不会直接判负，而是把选择权交给调用方
    // （对应 `can_try_to_pay_rent()` → rent_due 邮件）。基线策略一律**用掉**自救道具，
    // 否则循环会在「付不起又没判负」的状态里空转。
    // `payRent` 在一次调用里就要么付清、要么判负、要么（有自救道具时）
    // 返回 ok=false 交由调用方决定。**不能重复调用 `payRentWithItem`**
    // —— 它一旦成功就已推进到新一期并重置 spinsLeft，再调只会被
    // 「旋转次数尚未用尽」挡下。
    let paid = payRent(g);
    if (!paid.ok && !g.over) {
      const rescues = rentRescueOptions(g);
      if (rescues.length > 0) {
        const r2 = payRentWithItem(g, rescues[0]);
        // 自救后可能仍未付清（piggy_bank / swear_jar 攒得不够）→ 此时已判负
        paid = { ok: r2.paid, message: r2.message };
      }
      if (!g.over && !paid.ok) {
        issues.push(
          `付租既未付清也未判负（rescues=${rentRescueOptions(g).join(',') || '无'} coins=${g.coins} owed=${rentFor(g.floor, g.rentPaid + 1).rent}）`,
        );
        break;
      }
    }
    if (g.over || g.won) break;
    if (g.shopOpen) drainShop();
  }

  return { won: g.won, over: g.over, rounds, boss: Boolean(g.boss), issues };
}

const SEEDS = 240;
const runs: Run[] = Array.from({ length: SEEDS }, (_, i) => playOnce(9400 + i));
const flatIssues = runs.flatMap((r) => r.issues);
const wins = runs.filter((r) => r.won).length;
const deathAt = runs.filter((r) => !r.won && r.over).length;

check('B 引擎', '无逻辑不变量违规', flatIssues.length === 0, flatIssues.slice(0, 3).join(' · '));
check('B 引擎', '对局均能终止', runs.every((r) => r.won || r.over), `${SEEDS} 局`);
check('B 引擎', '破产与通关互斥', runs.every((r) => !(r.won && r.over)));

// 用破产期区间兜住「曲线整体漂移」：低于 3 期说明前期直接过难，
// 高于 12 期说明租金爬坡失效（该赢的局都被拖成无限局）。
// 区间上限跟着已还原的机制走：协同（target:adjacent）、销毁两段式、字符串谓词
// 补齐后，同一套策略能活到第 10 期，上限随之从 9 放宽到 12。
// 破产期数只在「没进房东战」的局里统计，房东战里的期数是 13+ 的另一套曲线
const deaths = runs.filter((r) => !r.won && !r.boss).map((r) => r.rounds);
const minDeath = deaths.length ? Math.min(...deaths) : 0;
const maxDeath = deaths.length ? Math.max(...deaths) : 0;
// 下限：起手 5 个 1 值符号 + 1 金币，第一期的现金流刚好卡在盈亏线附近，
// 洗牌运气差时确实会第二期就断（不是实现缺陷）。所以下限是 2，不是 3。
// 上限：租金爬坡如果失效，该赢的局会被拖成无限局，破产期会右移。
//
// 注意：每转 -1 金币 + 付租两次三选一（P0）落地后，基线策略的破产期
// 集中在第 5–6 期，这是原版「纯符号依附不可行」的直接体现
// （见 docs/Luck-be-a-Landlord-算法与机制整理.md §7 的结论）。
// P1（数值管线三槽位 / currency / highlander / 稀有度迁移）补齐前，
// 这里的产出会被低估，所以先只守上限，下限留给 P1 完成后再定。
check('B 引擎', '破产期不晚于 12 期（租金爬坡未失效）', maxDeath <= 12, `最晚 ${maxDeath} 期`);
info('B 引擎', '破产期最早', `${minDeath} 期（P1 补齐后重新校准下限）`);
const rate = wins / SEEDS;
const reachedBoss = runs.filter((r) => r.boss).length;
// 12 期可达：付满 12 期的局会直接进房东战（原版 boss_fight_1）。
//
// 基线策略是「池未满就买估值最高的符号，池满就买道具」，它**不做剪枝**
// —— 不用移除代币删掉 0/1 值的稀释符号，也不用换位去凑邻接。
// 而原版的核心张力恰恰在这里：池涨到 20+ 之后命中率掉到 20/S，
// 满盘符号的期望产出会被稀释回基础值附近（见
// docs/Luck-be-a-Landlord-算法与机制整理.md §8「空格是稀释剂」）。
//
// 但**完全打不到 12 期**就说明救助路径缺失了。
// 补齐 `devils_deal` / `piggy_bank` / `swear_jar` 之后，基线已有 3/240 局付满 12 期；
// 若这个数字回落到 0，说明自救链路又断了。
check(
  'B 引擎',
  '12 期可达（基线策略，未做剪枝/换位）',
  reachedBoss > 0,
  `${reachedBoss}/${SEEDS} 局付满 12 期`,
);
check('B 引擎', '通关不是送分（通关率 < 40%）', rate < 0.4, `${(rate * 100).toFixed(1)}%`);
info('B 引擎', '基线通关率', `${(rate * 100).toFixed(1)}% · ${deathAt} 局破产`);
info(
  'B 引擎',
  '基线策略说明',
  '「买最高值符号 + 池满买道具」，不剪枝、不换位；满池稀释后产出回落是原版设定',
);

/** 房东之战：12 期付完自动进入 → 血量按层（13 层 1500）→ 每回合收入即伤害 → 倒下才算真结局 */
function bossFightIssues(): string[] {
  const issues: string[] = [];
  const g = createGame(1234);
  g.rentPaid = 11;
  g.payment = 11;
  g.spinsLeft = 0;
  g.coins = 100000;

  const pay = payRent(g);
  if (!pay.ok) issues.push('第 12 期付租失败');
  if (g.won) issues.push('付满 12 期就判通关，没进房东战');
  if (!g.boss?.active) issues.push('付满 12 期未进入房东战');
  if (g.over) issues.push('进入房东战时同时置破产');
  if (!g.mails.some((m) => m.kind === 'boss_fight_1') || !g.mails.some((m) => m.kind === 'boss_fight_2')) {
    issues.push('未收到房东战两封信');
  }

  const maxHp = landlordMaxHp(g.floor);
  if (g.boss?.maxHp !== maxHp) issues.push(`房东血量不是 ${maxHp}`);
  if (g.spinsLeft < 5) issues.push('房东战未补旋转');
  if (g.finePrintThreshold !== Math.floor(maxHp / 10)) issues.push('细则阈值未跟随血条');

  // 第一刀：本回合收入就是伤害，金币不清零
  const beforeCoins = g.coins;
  dealBossDamage(g, 300);
  if (g.boss?.hp !== maxHp - 300) issues.push(`伤害未结算 ${g.boss?.hp}`);
  if (g.coins !== beforeCoins) issues.push('打房东不该扣金币');
  if (g.finePrintCounter >= g.finePrintThreshold) issues.push(`细则计数未按伤害结算 ${g.finePrintCounter}`);
  const expected = Math.floor(300 / g.finePrintThreshold);
  if (g.finePrints.length !== expected) issues.push(`300 伤害应换 ${expected} 条细则，实得 ${g.finePrints.length}`);

  // 房东战里按期付租（第 13 期 1000），不能误判为通关
  g.spinsLeft = 0;
  const paidBefore = g.rentPaid;
  if (!payRent(g).ok) issues.push('房东战付租失败');
  if (g.won) issues.push('房东战付租误判通关');
  if (g.rentPaid !== paidBefore + 1) issues.push('房东战付租未推进期数');

  // 收尾一刀：血量归零 → 房东倒下、置通关
  dealBossDamage(g, g.boss?.hp ?? 0);
  if (g.boss?.active) issues.push('血量归零后房东仍存活');
  if (!g.won) issues.push('击败房东未置通关');
  if (g.over) issues.push('击败房东时同时置破产');
  return issues;
}

const bossIssues = bossFightIssues();
check('B 引擎', '房东战流程闭环', bossIssues.length === 0, bossIssues.slice(0, 3).join(' · '));
check('B 引擎', '房东战租金 500 + (期数-12)*500', bossRent(13) === 1000 && bossRent(14) === 1500, '');

/* ── 楼层（Pop-up.current_floor）：开局选定、一局不变、决定租金加成 ── */

function floorRun(floor: number): { total: number; floorAfter: number } {
  const g = createGame(77, 'normal', floor);
  let total = 0;
  for (let i = 0; i < 12; i += 1) {
    g.spinsLeft = 0;
    g.coins = 1_000_000;
    const before = g.coins;
    payRent(g);
    total += before - g.coins;
  }
  return { total, floorAfter: g.floor };
}

const floorTotals: Record<number, number> = {
  1: 4277,
  2: 4302,
  3: 4327,
  5: 4327,
  6: 4352,
  7: 4352,
  8: 4377,
  13: 4377,
  14: 4377,
  17: 4377,
  18: 4402,
  20: 4402,
};
const floorBad = Object.entries(floorTotals).filter(([f, want]) => {
  const got = floorRun(Number(f));
  return got.total !== want || got.floorAfter !== Number(f);
});
check(
  'B 引擎',
  '楼层加成生效且楼层不再随付租漂移（1/2/3-5/6-7/8-17/18-20）',
  floorBad.length === 0,
  floorBad.map(([f]) => `第 ${f} 层=${floorRun(Number(f)).total}`).join(' · '),
);
check(
  'B 引擎',
  '房东血量按楼层 750 / 1000 / 1500',
  landlordMaxHp(1) === 750 && landlordMaxHp(11) === 1000 && landlordMaxHp(13) === 1500,
  `${landlordMaxHp(1)}/${landlordMaxHp(11)}/${landlordMaxHp(13)}`,
);
check(
  'B 引擎',
  '第 7/8/9/10/11 期分别 +25 的楼层门槛是 2/3/18/6/8',
  rentFor(1, 7).rent === 350 &&
    rentFor(2, 7).rent === 375 &&
    rentFor(2, 8).rent === 425 &&
    rentFor(3, 8).rent === 450 &&
    rentFor(13, 9).rent === 575 &&
    rentFor(18, 9).rent === 600 &&
    rentFor(5, 10).rent === 625 &&
    rentFor(6, 10).rent === 650 &&
    rentFor(7, 11).rent === 675 &&
    rentFor(8, 11).rent === 700,
  [1, 2, 3, 18, 6, 8].map((f) => `F${f}:${rentFor(f, 7).rent}/${rentFor(f, 9).rent}`).join(' '),
);

/** Reel.symbol_removal_effects：道具吃符号、细则 20/21 例外 */
function removalIssues(): string[] {
  const issues: string[] = [];
  const egg = SYMBOLS.find((s) => s.id === 'egg')!;
  const carton = ITEMS.find((s) => s.id === 'egg_carton')!;
  const g = createGame(321);
  for (const col of g.reels) for (const cell of col) cell.def = null;
  g.pool.length = 0;
  g.reels[0]![0]!.def = egg;
  g.reels[1]![0]!.def = egg;
  g.pool.push(egg, egg);
  g.items.push({ def: carton, count: 1 });
  applySymbolRemovalItems(g);
  if (g.items[0]?.savedValue !== 2) issues.push(`egg_carton 未累积 ${g.items[0]?.savedValue}`);
  if (g.pool.length !== 0) issues.push(`池未同步 ${g.pool.length}`);

  // 细则 21 生效时不再吃 egg
  g.finePrints.push({ num: 21, name: '细则 21', values: [] });
  g.reels[0]![0]!.def = egg;
  g.pool.push(egg);
  applySymbolRemovalItems(g);
  if (g.reels[0]![0]!.def?.id !== 'egg') issues.push('细则 21 生效时仍吃掉 egg');
  return issues;
}

const removal = removalIssues();
check('B 引擎', '道具吃符号（含细则 20/21 例外）', removal.length === 0, removal.slice(0, 3).join(' · '));

/* ── 道具侧生成声明：祭坛（叠层数）与莫比乌斯环（saved_value 上限）── */

/** Item__Item.gd:1957 祭坛、:2335 莫比乌斯环——以前这两条声明有行无数 */
function itemSpawnIssues(): string[] {
  const issues: string[] = [];
  const shrine = ITEMS.find((i) => i.id === 'shrine')!;
  const mobius = ITEMS.find((i) => i.id === 'mobius_strip')!;
  const organism = SYMBOLS.find((s) => s.groups?.includes('organism'))!;
  const box = SYMBOLS.find((s) => s.groups?.includes('box'))!;

  const dead = (def: unknown) => {
    const cell = createCell(def as never);
    cell.destroyed = true;
    return cell;
  };

  // 祭坛：叠 3 层 → 一个被摧毁的生物符号应当换来 3 个灵魂
  const shrineSpawns: Array<{ type?: string }> = [];
  applyItemEffects(
    [{ def: shrine, count: 3 }],
    [dead(organism), createCell(null)],
    { chanceRoll: () => 0.1, spawn: (spec) => shrineSpawns.push(spec) },
  );
  if (shrineSpawns.length !== 3) issues.push(`祭坛 3 层只生成 ${shrineSpawns.length} 个`);
  if (shrineSpawns.some((s) => s.type !== 'spirit')) issues.push('祭坛生成的不是灵魂');

  // 莫比乌斯环：50% 命中 → 把被摧毁的符号原样补回，并攒一次 saved_value
  const hitSpawns: Array<{ type?: string }> = [];
  const hitItem: { def: unknown; count: number; savedValue?: number } = { def: mobius, count: 1 };
  applyItemEffects([hitItem as never], [dead(box), createCell(null)], {
    chanceRoll: () => 0.1,
    spawn: (spec) => hitSpawns.push(spec),
  });
  if (hitSpawns.length !== 1) issues.push(`莫比乌斯环命中却生成 ${hitSpawns.length} 个`);
  if (hitSpawns[0]?.type !== box.id) issues.push(`补回的符号是 ${hitSpawns[0]?.type} 而非 ${box.id}`);
  if (hitItem.savedValue !== 1) issues.push(`saved_value 未 +1（${hitItem.savedValue}）`);

  // 上限由 `saved_value < values[1]` 控制：攒满 7 次后不再补
  const cappedSpawns: Array<unknown> = [];
  applyItemEffects([{ def: mobius, count: 1, savedValue: 7 }], [dead(box), createCell(null)], {
    chanceRoll: () => 0.1,
    spawn: (spec) => cappedSpawns.push(spec),
  });
  if (cappedSpawns.length !== 0) issues.push(`攒满 7 次后仍在补（${cappedSpawns.length}）`);
  return issues;
}

const itemSpawn = itemSpawnIssues();
check('B 引擎', '道具生成（祭坛叠层 / 莫比乌斯环上限）', itemSpawn.length === 0, itemSpawn.join(' · '));

/* ── 精华文案：不能把「销毁自己」这类技术声明念给玩家 ── */

function essenceTextIssues(): string[] {
  const issues: string[] = [];
  for (const e of ESSENCES) {
    if (!isEssence(e.id)) {
      issues.push(`${e.id} 不是精华却进了精华表`);
      continue;
    }
    const lines = essenceLines(e.id);
    if (lines.length < 2) issues.push(`${e.id} 只有 ${lines.length} 行`);
    if (lines.some((t) => t.includes('摧毁自己'))) issues.push(`${e.id} 仍念出「摧毁自己」`);
    if (lines.some((t) => t.includes('被其他符号触发'))) issues.push(`${e.id} 仍念出触发技术句`);
    if (lines.some((t) => t.includes('本符号'))) issues.push(`${e.id} 残留「本符号」`);
    if (!lines.some((t) => t.includes('强化版') || t.includes('精华'))) {
      issues.push(`${e.id} 没有说清是强化版`);
    }
    // 末行必须交代它怎么没的，否则玩家不知道这是一次性消耗品
    if (!/(消耗|一次性)/.test(lines[lines.length - 1] ?? '')) {
      issues.push(`${e.id} 末行没交代消耗方式`);
    }
  }
  if (issues.length > 0) return issues.slice(0, 4);
  return issues;
}

const essenceText = essenceTextIssues();
check('B 引擎', '精华文案按消耗品措辞', essenceText.length === 0, essenceText.join(' · '));


/* ── 三种代币（原版 reroll / removal / essence）── */

/** 依次递增的确定性 rand */
function sequencer(step = 0.137): () => number {
  let v = 0.113;
  return () => {
    v = (v + step) % 1;
    return v;
  };
}

const fresh = createGame(4321);
check(
  'B 引擎',
  '初始无代币、成本各 1',
  fresh.rerollTokens === 0 &&
    fresh.removalTokens === 0 &&
    fresh.essenceTokens === 0 &&
    fresh.rerollCost === 1 &&
    fresh.removalCost === 1,
  `r=${fresh.rerollTokens} m=${fresh.removalTokens} e=${fresh.essenceTokens}`,
);

// 代币卡**不应**出现在商店里：三张原始 JSON 都没有 token 卡牌，
// 原版的三种代币只来自符号产出（currency 声明）与同伴援助。
// 这条断言用来守住「不要又把自造的代币卡塞回来」。
const tokenShop = createGame(99);
tokenShop.rand = () => 0;
tokenShop.spinsLeft = 0;
tokenShop.coins = 100000;
payRent(tokenShop);
const tokenLeak = [...tokenShop.shop, ...tokenShop.shopQueue].filter(
  (c) => typeof c === 'object' && c !== null && 'token' in c && (c as { token?: string }).token,
) as Array<{ token?: string }>;
check(
  'B 引擎',
  '商店不出自造代币卡',
  tokenLeak.length === 0,
  tokenShop.shop.map((c) => c.token ?? c.def.id).join(','),
);

// 付租奖励是两批（符号 + 道具）：第一批全符号、第二批全道具
const rentStages = { symbolAll: false, itemAll: false, twoBatches: false };
{
  const g = createGame(1234);
  g.spinsLeft = 0;
  g.coins = 100000;
  payRent(g);
  const first = g.shop.map((c) => isItemDef(c.def));
  rentStages.symbolAll = first.length > 0 && first.every((v) => v === false);
  rentStages.twoBatches = g.shopQueue.includes('rent-item');
  // 跳过第一批 → 第二批应当是纯道具
  closeShop(g);
  const second = g.shop.map((c) => isItemDef(c.def));
  rentStages.itemAll = second.length > 0 && second.every((v) => v === true);
}
check(
  'B 引擎',
  '付租奖励 = 符号批 + 道具批（两次独立三选一）',
  rentStages.symbolAll && rentStages.itemAll && rentStages.twoBatches,
  `符号批=${rentStages.symbolAll} 道具批=${rentStages.itemAll} 有第二批=${rentStages.twoBatches}`,
);

// 付租符号批的稀有度是写死配比（Pop-up__Pop-up.gd:2688），不是概率表
{
  const g = createGame(555);
  g.spinsLeft = 0;
  g.coins = 100000;
  g.payment = 9; // 第 10 期：rare, rare, rare
  g.rentPaid = 9;
  payRent(g);
  const allRare = g.shop.length > 0 && g.shop.every((c) => c.rarity === 'rare');
  check('B 引擎', '付租符号批走强制稀有度配比（第 10 期全 rare）', allRare,
    g.shop.map((c) => c.rarity).join(','));
}

const rr = createGame(7);
rr.rand = sequencer();
rr.spinsLeft = 0;
rr.coins = 100000;
payRent(rr);
rr.rerollTokens = 3;
const shopBefore = rr.shop.map((c) => c.def.id).join(',');
const rrRes = rerollShop(rr);
check(
  'B 引擎',
  '重掷：扣代币并换一批候选',
  rrRes.ok && rr.rerollTokens === 2 && rr.shop.length === 3,
  `ok=${rrRes.ok} tokens=${rr.rerollTokens} ${shopBefore} → ${rr.shop.map((c) => c.def.id).join(',')}`,
);

const rm = createGame(5);
spin(rm);
rm.removalTokens = 2;
const rmIdx = rm.cells.findIndex((c) => c.def);
const poolBefore = rm.pool.length;
const rmRes = removeSymbolAt(rm, rmIdx);
check(
  'B 引擎',
  '移除符号：扣代币、清格、池同步',
  rmRes.ok && rm.removalTokens === 1 && rm.pool.length === poolBefore - 1 && !rm.cells[rmIdx]?.def,
  `ok=${rmRes.ok} tokens=${rm.removalTokens} pool=${poolBefore}→${rm.pool.length}`,
);

const es = createGame(11);
es.essenceTokens = 1;
es.items.push({ def: PLACEABLES.find((p) => p.id === 'chili_powder') ?? ITEMS[0], count: 1 });
const baseId = es.items[0].def.id;
const esRes = essenceUpgrade(es, baseId);
check(
  'B 引擎',
  '精华升级：换 def 并消耗代币',
  esRes.ok && es.essenceTokens === 0 && es.items[0].def.id === `${baseId}_essence`,
  `ok=${esRes.ok} ${baseId} → ${es.items[0].def.id} tokens=${es.essenceTokens}`,
);

// 精华代币在付租时兑现成「三张精华任选」商店，不是作废
// （Pop-up__Pop-up.gd:2876 → :2661）。3 枚 → 付租两批 + 3 批精华。
const carry = createGame(13);
carry.essenceTokens = 3;
carry.spinsLeft = 0;
carry.coins = 100000;
payRent(carry);
const carryQueue = carry.shopQueue.filter((s) => s === 'rent-essence').length;
check(
  'B 引擎',
  '付租：精华代币兑现成三选一商店而非作废',
  carry.essenceTokens === 0 && carryQueue === 3,
  `e=${carry.essenceTokens} 精华批次=${carryQueue}`,
);
// 精华批的候选必须全是精华（rarity 标为 rare，def 指向 essences.json 的项）
{
  const g = createGame(17);
  g.essenceTokens = 1;
  g.spinsLeft = 0;
  g.coins = 100000;
  payRent(g);
  closeShop(g); // 跳过符号批
  closeShop(g); // 跳过道具批
  const essenceIds = new Set(ESSENCES.map((e) => e.id));
  const allEssence = g.shop.length > 0 && g.shop.every((c) => essenceIds.has(c.def.id));
  check(
    'B 引擎',
    '精华批的候选全部是精华',
    allEssence,
    g.shop.map((c) => c.def.id).join(','),
  );
}

const dudRun = createGame(3, 'normal', 10);
dudRun.rentPaid = 3;
dudRun.totalSpins = 25;
const dudBefore = dudRun.pool.filter((d) => d.id === 'dud').length;
spin(dudRun);
const dudAfter = dudRun.pool.filter((d) => d.id === 'dud').length;
check(
  'B 引擎',
  '第 10 层起每 25 转注入 1 个 dud',
  dudAfter === dudBefore + 1,
  `${dudBefore} → ${dudAfter}`,
);

/* ── 房东信箱 + 同伴楼层缩放（原版 emails / comrade_values）── */

const stairs = [1, 4, 9, 16].map((f) => comradeValues(f));
check(
  'B 引擎',
  '同伴援助按楼层递减 [2,2,2]→[2,1,2]→[1,1,2]→[1,1,1]',
  stairs[0].reroll === 2 &&
    stairs[0].removal === 2 &&
    stairs[0].essence === 2 &&
    stairs[1].reroll === 2 &&
    stairs[1].removal === 1 &&
    stairs[2].essence === 2 &&
    stairs[3].reroll === 1 &&
    stairs[3].removal === 1 &&
    stairs[3].essence === 1,
  stairs.map((s) => `${s.reroll}/${s.removal}/${s.essence}`).join(' → '),
);

const opening = createGame(19);
check(
  'B 引擎',
  '开局收到房东第一封信',
  opening.mails.length === 1 && opening.mails[0].kind === 'intro' && !opening.mails[0].read,
  opening.mails.map((m) => m.kind).join(','),
);

const comradeRun = createGame(23);
comradeRun.coins = 100000;
for (let i = 0; i < 3; i += 1) {
  comradeRun.spinsLeft = 0;
  payRent(comradeRun);
}
check(
  'B 引擎',
  '第 3 期同伴来信：三种代币按第 1 层档位入账',
  comradeRun.rentPaid === 3 &&
    comradeRun.rerollTokens === 2 &&
    comradeRun.removalTokens === 2 &&
    comradeRun.essenceTokens === 2 &&
    comradeRun.mails.some((m) => m.kind === 'init_comrade_help'),
  `tokens=${comradeRun.rerollTokens}/${comradeRun.removalTokens}/${comradeRun.essenceTokens} mails=${comradeRun.mails.map((m) => m.kind).join(',')}`,
);

const highRun = createGame(23, 'normal', 16);
highRun.coins = 100000;
for (let i = 0; i < 3; i += 1) {
  highRun.spinsLeft = 0;
  payRent(highRun);
}
check(
  'B 引擎',
  '第 16 层同伴代币 1/1/1（comrade_values 楼层缩放）',
  highRun.rerollTokens === 1 && highRun.removalTokens === 1 && highRun.essenceTokens === 1,
  `tokens=${highRun.rerollTokens}/${highRun.removalTokens}/${highRun.essenceTokens}`,
);

comradeRun.spinsLeft = 0;
payRent(comradeRun);
comradeRun.spinsLeft = 0;
payRent(comradeRun);
check(
  'B 引擎',
  '信箱同类合并：comrade_help 只留一封',
  comradeRun.mails.filter((m) => m.kind === 'comrade_help').length === 1,
  comradeRun.mails.map((m) => m.kind).join(','),
);

const unreadBefore = unreadMails(comradeRun);
markMailRead(comradeRun, comradeRun.mails[0].id);
check(
  'B 引擎',
  '已读状态与未读计数',
  unreadMails(comradeRun) === unreadBefore - 1 && comradeRun.mails[0].read,
  `${unreadBefore} → ${unreadMails(comradeRun)}`,
);

const broke = createGame(24);
broke.coins = 0;
broke.spinsLeft = 0;
payRent(broke);
check(
  'B 引擎',
  '破产会收到退租信',
  broke.over && broke.mails.some((m) => m.kind === 'game_over'),
  broke.mails.map((m) => m.kind).join(','),
);

check(
  'B 引擎',
  '邮件里的道具名带原作英文名对照',
  tagOf('chili_powder').includes('辣椒') && tagOf('chili_powder').includes('Chili Powder'),
  tagOf('chili_powder'),
);

const sandbox = createGame(7, 'sandbox');
check(
  'B 引擎',
  '沙盒从第 12 期起且金币管饱',
  sandbox.rentPaid === 11 && sandbox.coins >= 999999 && sandbox.mode === 'sandbox',
  `rentPaid=${sandbox.rentPaid} coins=${sandbox.coins}`,
);

const endless = createGame(8, 'endless');
endless.rentPaid = 11;
endless.payment = 11;
endless.spinsLeft = 0;
endless.coins = 1_000_000;
payRent(endless);
check(
  'B 引擎',
  '无尽模式付完 12 期不结束',
  !endless.won && !endless.over && endless.rentPaid === 12,
  `won=${endless.won} over=${endless.over} rentPaid=${endless.rentPaid}`,
);

/* ── B2. 换位装置（原版唯一的位置干预，Pop-up__Pop-up.gd:2638） ── */

// 没有道具时：停盘即结算，也没有换位入口
const noSwap = createGame(24);
noSwap.cells = visibleCells(noSwap.reels);
const noSwapStart = beginSpin(noSwap);
const noSwapTry = swapSymbols(noSwap, 0, 1);
check(
  'B 引擎',
  '没有换位装置就不能换位',
  noSwapStart === 'resolving' && noSwapTry.ok === false,
  `${noSwapStart} / ${noSwapTry.message}`,
);

// 持有道具时：停盘后必须等玩家决定，每转只能换一次
const withSwap = createGame(24);
const devDef = ITEMS.find((it) => it.id === 'swapping_device');
withSwap.items.push({ def: devDef, count: 1 });
withSwap.cells = visibleCells(withSwap.reels);
const swapStart = beginSpin(withSwap);
const coinsBeforeResolve = withSwap.coins;
resolveSpin(withSwap); // 还在等待窗口里，应被挡下
const blocked = withSwap.coins === coinsBeforeResolve && withSwap.swapPending;

const pick = withSwap.cells.findIndex((c) => c.def);
const pick2 = withSwap.cells.findIndex((c, i) => c.def && i !== pick);
const first = swapSymbols(withSwap, pick, pick2);
const swappedCorrectly =
  first.ok &&
  withSwap.cells[pick].def?.id === withSwap.reels[pick % COLS][Math.floor(pick / COLS) + 1]?.def?.id;
const second = swapSymbols(withSwap, pick2, pick);
check(
  'B 引擎',
  '换位装置：停盘后等玩家，且每转只能换一次',
  swapStart === 'awaiting-swap' && blocked && swappedCorrectly && second.ok === false,
  `start=${swapStart} blocked=${blocked} first=${first.ok} second=${second.ok}(${second.message})`,
);

// 跳过换位：这一转照常结算
const skipGame = createGame(24);
skipGame.items.push({ def: devDef, count: 1 });
skipGame.cells = visibleCells(skipGame.reels);
const skipStart = beginSpin(skipGame);
skipSwap(skipGame);
resolveSpin(skipGame);
check(
  'B 引擎',
  '跳过换位后照常结算',
  skipStart === 'awaiting-swap' && !skipGame.swapPending && skipGame.totalSpins === 1,
  `start=${skipStart} spins=${skipGame.totalSpins}`,
);

// 油壶：重摇一列会改写该列构成，并让该列的符号吃到本轮倍率
{
  const g = createGame(4321);
  g.items.push({ def: symbol('oil_can'), count: 1 });
  g.spinsLeft = 5;
  g.coins = 100;
  const started = beginSpin(g);
  const canBefore = canRespinReel(g);
  const colBefore = g.cells
    .filter((_, i) => i % COLS === 0)
    .map((c) => c.def?.id ?? '')
    .join(',');
  const res = respinReel(g, 0);
  const colAfter = g.cells
    .filter((_, i) => i % COLS === 0)
    .map((c) => c.def?.id ?? '')
    .join(',');
  const marked = g.respunReel === 0;
  const secondTry = respinReel(g, 1);
  check(
    'B 引擎',
    '油壶：重摇一列并标记 respunReel（每转一次）',
    started === 'resolving' && canBefore && res.ok && marked && !secondTry.ok,
    `can=${canBefore} col=${colBefore}→${colAfter} marked=${marked} 二次=${secondTry.ok}`,
  );
}

// 万能牌：flat_value_bonus 向相邻万能牌传播（只增不减）
{
  const g = createGame(2468);
  const donor = g.cells[0];
  const wc = g.cells[1];
  donor.def = symbol('wanted_poster');
  donor.flatValueBonus = 3;
  wc.def = symbol('wildcard');
  wc.wildcarded = true;
  wc.flatValueBonus = 0;
  const before = wc.flatValueBonus;
  spreadWildcardFlatBonus(g.cells);
  check(
    'B 引擎',
    '万能牌继承相邻固定加值',
    wc.flatValueBonus === 3 && before === 0,
    `${before} → ${wc.flatValueBonus}`,
  );
}

// currency：代币产出不能算成金币（jellyfish / pufferfish / *_capsule）
{
  const g = createGame(31415);
  g.reels[0][1] = createCell(symbol('jellyfish'));
  g.pool.push(symbol('jellyfish'));
  // jellyfish 的声明条件是 {removed:true}，手工触发一次移除路径
  g.removalTokens = 9;
  g.cells = visibleCells(g.reels);
  const coinsBefore = g.coins;
  const rerollBefore = g.rerollTokens;
  const removalBefore = g.removalTokens;
  removeSymbolAt(g, 0);
  const dCoins = g.coins - coinsBefore;
  const dReroll = g.rerollTokens - rerollBefore;
  // 扣 1 枚移除代币，但 jellyfish 自己又补回 values[0] 枚移除代币
  const dRemoval = g.removalTokens - removalBefore;
  check(
    'B 引擎',
    'currency：水母被移除时给移除代币而非金币',
    dCoins === 0 && dReroll === 0 && dRemoval >= 0,
    `coin=${dCoins} reroll=${dReroll} removal=${dRemoval}`,
  );
}

// devils_deal：付不起租时销毁自己免租，代价是棋盘被空格填满
{
  const g = createGame(778);
  g.items.push({ def: symbol('devils_deal'), count: 1 });
  g.spinsLeft = 0;
  g.coins = 0; // 一分钱都没有
  const owed = rentFor(g.floor, g.rentPaid + 1).rent;
  const niceBefore = g.niceEmpties;
  const rescue = rentRescueOptions(g);
  const res = payRentWithItem(g, 'devils_deal');
  check(
    'B 引擎',
    'devils_deal：销毁抵租，永久关闭「剔除多余空格」保护',
    rescue.includes('devils_deal') && res.ok && res.paid &&
      g.rentPaid === 1 && g.coins === 0 && niceBefore && !g.niceEmpties,
    `救援=${rescue.join(',')} paid=${res.paid} 免租${owed} nice_empties ${niceBefore}→${g.niceEmpties} 期=${g.rentPaid}`,
  );
}

// 关闭保护后，洗牌不再把池压回 25
{
  const g = createGame(781);
  g.niceEmpties = false;
  // 人为塞满每一列的 5 个槽位（25 个），其中一半是空格
  for (const col of g.reels) {
    while (col.length < SLOTS_PER_REEL) col.push(createCell(null));
  }
  const before = g.reels.reduce((n, c) => n + c.length, 0);
  spin(g);
  const after = g.reels.reduce((n, c) => n + c.length, 0);
  check(
    'B 引擎',
    '关闭 nice_empties 后洗牌不压缩池',
    after >= SLOTS_PER_REEL * COLS,
    `槽位 ${before} → ${after}`,
  );
}

// piggy_bank / swear_jar：销毁换钱，钱不够仍判负
{
  const g = createGame(779);
  g.items.push({ def: symbol('swear_jar'), count: 1, savedValue: 10 });
  g.spinsLeft = 0;
  g.coins = 0;
  const res = payRentWithItem(g, 'swear_jar');
  // swear_jar values = [1, 3, 35] → 10 * 3 = 30 金币，第 1 期需 25 → 能付
  check(
    'B 引擎',
    'swear_jar：销毁换钱后可付清',
    res.ok && res.paid && g.rentPaid === 1,
    `paid=${res.paid} coins=${g.coins} 期=${g.rentPaid}`,
  );
}

// bag_of_holding：每层多给一次道具三选一
{
  const g = createGame(9001);
  g.items.push({ def: symbol('bag_of_holding'), count: 2 });
  g.spinsLeft = 0;
  g.coins = 100000;
  payRent(g);
  const itemBatches = g.shopQueue.filter((s) => s === 'rent-item').length;
  check(
    'B 引擎',
    'bag_of_holding：每层追加一次道具三选一',
    itemBatches === 3, // 1 基础 + 2 层
    `道具批次=${itemBatches}（期望 1 基础 + 2）`,
  );
}

// frozen_pizza：攒满后兑现一次额外符号三选一并归零
{
  const g = createGame(9002);
  const pizza = symbol('frozen_pizza');
  const need = pizza.values?.[0] ?? 0;
  g.items.push({ def: pizza, count: 1, savedValue: need });
  g.spinsLeft = 0;
  g.coins = 100000;
  payRent(g);
  // 注意：`openNextQueuedShop` 已经 shift 掉第一批并开成当前商店，
  // 所以 `shopQueue` 里剩下的是「后续批次」。基础 1 + 兑现 1 = 2 批，
  // shift 之后剩 1 批符号 + 1 批道具。
  const symBatches = g.shopQueue.filter((s) => s === 'rent-symbol').length;
  const savedAfter = g.items.find((it) => it.def.id === 'frozen_pizza')?.savedValue;
  check(
    'B 引擎',
    'frozen_pizza：攒满兑现额外符号批并归零',
    symBatches === 1 && savedAfter === 0, // 2 批符号中已 shift 掉 1 批
    `剩余符号批次=${symBatches} saved_value=${savedAfter}`,
  );
}

// shattered_mirror：减少候选数
{
  const g = createGame(9003);
  const mirror = symbol('shattered_mirror');
  g.items.push({ def: mirror, count: 1, savedValue: 0 });
  g.spinsLeft = 0;
  g.coins = 100000;
  payRent(g);
  // 基础 3 张 − mirror.values[2]；候选数小于 3 即说明生效
  check(
    'B 引擎',
    'shattered_mirror：减少候选数',
    g.shop.length < 3 && g.shop.length >= 0,
    `候选=${g.shop.length}（mirror values[2]=${mirror.values?.[2]}）`,
  );
}

// 近期摧毁道具的冷却：入列 3，每付租减 1，归零后移出
{
  const g = createGame(9101);
  g.items.push({ def: symbol('swear_jar'), count: 1, savedValue: 999 });
  g.spinsLeft = 0;
  g.coins = 0;
  payRentWithItem(g, 'swear_jar'); // 销毁 → 进冷却
  // 销毁本身就发生在付租那一刻，`settleRent` 已经在同一次调用里递减过一轮，
  // 所以这里读到的已经是 2（3 − 1）。
  const afterDestroy = g.recentlyDestroyedItems.map((r) => `${r.type}:${r.payments}`);
  g.spinsLeft = 0;
  g.coins = 100000;
  payRent(g);
  const afterOne = g.recentlyDestroyedItems.map((r) => r.payments);
  g.spinsLeft = 0;
  g.coins = 100000;
  payRent(g);
  const afterTwo = g.recentlyDestroyedItems.length;
  check(
    'B 引擎',
    '近期摧毁道具：3 期冷却后解禁',
    afterDestroy[0] === 'swear_jar:2' && afterOne[0] === 1 && afterTwo === 0,
    `${afterDestroy.join(',')} → 再1期=${afterOne.join(',') || '空'} → 再1期=${afterTwo}`,
  );
}

// 道具禁用开关
{
  const g = createGame(9102);
  g.items.push({ def: symbol('lucky_cat'), count: 1 });
  const okToggle = toggleItemEnabled(g, 'lucky_cat');
  const isDisabled = g.items[0].disabled === true;
  const blocked = canToggleItem(g, 'popsicle');
  const okToggleBack = toggleItemEnabled(g, 'lucky_cat');
  check(
    'B 引擎',
    '道具禁用开关：可切换，popsicle 不可禁用',
    okToggle.ok && isDisabled && !blocked && okToggleBack.ok && !g.items[0].disabled,
    `toggle=${okToggle.ok} disabled=${isDisabled} popsicle可禁用=${blocked} 回切=${okToggleBack.ok}`,
  );
}

// oil_can_essence：有限次重摇，用尽后自毁
{
  const g = createGame(9201);
  const ess = symbol('oil_can_essence');
  const limit = ess.values?.[0] ?? 0;
  g.items.push({ def: ess, count: 1, savedValue: 0 });
  g.spinsLeft = 5;
  g.coins = 100;
  const ids: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    beginSpin(g);
    const r = respinReel(g, 0);
    if (!r.ok) break;
    ids.push(String(g.items.find((it) => it.def.id === 'oil_can_essence')?.savedValue ?? 'gone'));
  }
  const gone = !g.items.some((it) => it.def.id === 'oil_can_essence');
  check(
    'B 引擎',
    'oil_can_essence：有限次重摇，用尽后自毁',
    limit > 0 && gone,
    `上限=${limit} 计数轨迹=${ids.join(',')} 已消失=${gone}`,
  );
}

// treasure_map：攒满前不可摧毁，攒满后兑现钥匙 + 宝箱
{
  const g = createGame(9202);
  const map = symbol('treasure_map');
  const need = map.values?.[0] ?? 0;
  g.items.push({ def: map, count: 1, savedValue: 0 });
  const lockedBefore = !isItemDestroyable(g, 'treasure_map');
  g.spinsLeft = 0;
  g.coins = 100000;
  // 手动攒满
  const held = g.items.find((it) => it.def.id === 'treasure_map')!;
  held.savedValue = need;
  const unlockedAfter = isItemDestroyable(g, 'treasure_map');
  const hasKeyBefore = g.pool.some((d) => d.id === 'key');
  payRent(g);
  const hasKey = g.pool.some((d) => d.id === 'key');
  const hasChest = g.pool.some((d) => d.id === 'treasure_chest');
  check(
    'B 引擎',
    'treasure_map：攒满前锁死，攒满后给钥匙+宝箱',
    lockedBefore && unlockedAfter && !hasKeyBefore && hasKey && hasChest,
    `锁定=${lockedBefore} 解锁=${unlockedAfter} 钥匙=${hasKey} 宝箱=${hasChest}`,
  );
}

// drained：被汲取的符号产出归零
{
  const c = createCell(symbol('coin'));
  c.def = { ...symbol('coin'), value: 10 };
  c.drained = true;
  const v = evaluateCell(c).final;
  check('B 引擎', 'drained 符号产出归零', v === 0, String(v));
}

/* ── C. 交互键位 ── */

// views.ts 是分析页的静态渲染模块，已不再挂到界面，只在 A 段做措辞检查
const srcFiles = ['main.ts', 'game.ts'].map((f) =>
  fs.readFileSync(path.join(WEB, 'src', f), 'utf8'),
);
const allSrc = srcFiles.join('\n');

const actionsInMarkup = new Set(
  [...allSrc.matchAll(/data-action="([a-zA-Z-]+)"/g)].map((m) => m[1]),
);
const handled = new Set([...allSrc.matchAll(/case '([a-zA-Z-]+)':/g)].map((m) => m[1]));

const deadKeys = [...actionsInMarkup].filter((a) => !handled.has(a));
// 移除语义：被移除的符号要先结算自己的 {removed:true} 声明再消失（牡蛎掉珍珠）
{
  const st = createGame(4242, 'normal', 1);
  st.removalTokens = 9;
  st.reels[0][1] = createCell(symbol('oyster')!);
  st.pool.push(symbol('oyster')!);
  st.cells = visibleCells(st.reels);
  const before = st.cells.filter((c) => c.def?.id === 'pearl').length;
  removeSymbolAt(st, 0);
  const after = st.cells.filter((c) => c.def?.id === 'pearl').length;
  check('B 引擎', '牡蛎被移除时掉珍珠', after > before, `珍珠 ${before} → ${after}`);
}

check('C 交互', '所有 data-action 都有 handler', deadKeys.length === 0, deadKeys.join(','));

const deadCases = [...handled].filter((a) => !actionsInMarkup.has(a));
info('C 交互', '无标记触发的 case', deadCases.length ? deadCases.join(',') : '无');
info('C 交互', '键位总数', `${actionsInMarkup.size} 个 data-action / ${handled.size} 个 case`);

/* ── D. 构建产物 ── */

const DIST = path.join(WEB, 'dist');
const hasDist = fs.existsSync(path.join(DIST, 'index.html'));
check('D 产物', 'dist/index.html 存在', hasDist, hasDist ? '' : '先跑 npm run build');

if (hasDist) {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('http') && !u.startsWith('data:'));
  const missing = refs.filter((u) => !fs.existsSync(path.join(DIST, u.replace(/^\//, ''))));
  check('D 产物', 'HTML 引用的资源齐备', missing.length === 0, missing.join(','));
  check('D 产物', '无本地调试地址', !/localhost|127\.0\.0\.1|file:\/\//.test(html), '');
  check('D 产物', '无外链 CDN（可离线）', !/https?:\/\//.test(html.replace(/https?:\/\/s\.w\.org/g, '')), '');

  let bytes = 0;
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else bytes += fs.statSync(p).size;
    }
  };
  walk(DIST);
  info('D 产物', 'dist 总体积', `${(bytes / 1024).toFixed(1)} KB`);
  check('D 产物', '体积 < 1.5 MB', bytes < 1.5 * 1024 * 1024, `${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

/* ── 输出 ── */

const groups = [...new Set(rows.map((r) => r.group))];
let failed = 0;
for (const g of groups) {
  console.log(`\n${g}`);
  for (const r of rows.filter((x) => x.group === g)) {
    if (!r.ok) failed += 1;
    const mark = r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
}

console.log(
  `\n${failed === 0 ? 'PASS' : 'FAIL'}  ${rows.filter((r) => r.ok).length}/${rows.length} 项通过`,
);
process.exitCode = failed === 0 ? 0 : 1;
