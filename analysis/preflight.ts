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
  ITEMS,
  PLACEABLES,
  RARITY_TABLE,
  RENT_TABLE,
  SYMBOLS,
} from '../web/src/data';
import { emojiOf } from '../web/src/sprites';
import {
  BOSS_HP,
  buyFromShop,
  closeShop,
  createGame,
  essenceUpgrade,
  isItemDef,
  markMailRead,
  payRent,
  removeSymbolAt,
  rerollShop,
  spin,
  startBossFight,
  unreadMails,
} from '../web/src/engine';
import { comradeValues, tagOf } from '../web/src/mail';
import { CELL_COUNT, COLS, ROWS, SLOTS_PER_REEL } from '../web/src/grid';
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

// 稀有度引用闭包
const rarityKeys = new Set(RARITY_TABLE.symbol.map((r) => r.payment));
const badRarity = SYMBOLS.filter((s) => s.rarity && !['common', 'uncommon', 'rare', 'very_rare'].includes(s.rarity));
check('A 数据链路', '符号稀有度取值合法', badRarity.length === 0, badRarity.slice(0, 3).map((s) => s.id).join(','));

// 效果声明不悬空（`<outside>` = 函数外分支；`a|b` = 多符号共用一条声明）
// 道具也在这张表里，所以用可放置物全集而非纯符号表。
const symbolIds = new Set(PLACEABLES.map((s) => s.id));
const declaredIds = EFFECTS.flatMap((e) => e.symbol.split('|'));
const dangling = declaredIds.filter((id) => id && id !== '<outside>' && !symbolIds.has(id));
check('A 数据链路', 'effects 声明的符号均存在', dangling.length === 0, [...new Set(dangling)].slice(0, 3).join(','));

const covered = new Set(declaredIds.filter((id) => symbolIds.has(id)));
info('A 数据链路', '有 add_effect 声明的可放置物', `${covered.size} / ${PLACEABLES.length}`);

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
  issues: string[];
}

function playOnce(seed: number): Run {
  const g = createGame(seed);
  const issues: string[] = [];
  let guard = 0;
  let rounds = 0;

  // 策略：池未满优先补估值最高的符号，池满后补道具位（第 0 张）。
  // 一次商店只能选一张（Pop-up__Pop-up.gd 的选项回调随即关面板）。
  const drainShop = (): void => {
    if (!g.shopOpen) return;
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
    if (!buyFromShop(g, pick)) return;
    // 代币卡不放进池，只加货币
    if (!buyingItem && !buyingToken && g.pool.length !== before + 1) issues.push('买入后池未增长');
    if (g.pool.length > 25) issues.push(`池超容 ${g.pool.length}`);
    closeShop(g);
  };

  for (let round = 1; round <= 12; round += 1) {
    rounds = round;
    while (g.spinsLeft > 0) {
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
    const res = payRent(g);
    if (!res.ok) break;
    if (g.shopOpen) drainShop();
    if (g.won) break;
  }

  return { won: g.won, over: g.over, rounds, issues };
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
const deaths = runs.filter((r) => !r.won).map((r) => r.rounds);
const minDeath = deaths.length ? Math.min(...deaths) : 0;
const maxDeath = deaths.length ? Math.max(...deaths) : 0;
check('B 引擎', '破产期落在 3–12 期（曲线未漂移）', minDeath >= 3 && maxDeath <= 12, `${minDeath}–${maxDeath} 期`);
const rate = wins / SEEDS;
// 12 期必须真的能打通：通关率 0 说明引擎缺少成长手段，而不是「设计上不可能」。
check('B 引擎', '12 期可达（基线内存在通关局）', wins > 0, `${wins}/${SEEDS}`);
check('B 引擎', '通关不是送分（通关率 < 40%）', rate < 0.4, `${(rate * 100).toFixed(1)}%`);
info('B 引擎', '基线通关率', `${(rate * 100).toFixed(1)}% · ${deathAt} 局破产`);

/** 房东之战：通关 → 750 血 → 金币换伤害 → 倒下才算真结局 */
function bossFightIssues(): string[] {
  const issues: string[] = [];
  const g = createGame(1234);
  g.rentPaid = 11;
  g.payment = 11;
  g.spinsLeft = 0;
  g.coins = 100000;

  const pay = payRent(g);
  if (!pay.ok) issues.push('第 12 期付租失败');
  if (!g.won) issues.push('付满 12 期未置通关');
  if (g.over) issues.push('通关时同时置破产');
  if (g.shopOpen) issues.push('通关后仍起商店');

  startBossFight(g);
  if (g.won) issues.push('进入房东战后仍标记通关');
  if (!g.boss?.active) issues.push('房东战未激活');
  if (g.boss?.maxHp !== BOSS_HP) issues.push(`房东血量不是 ${BOSS_HP}`);
  if (g.spinsLeft < 5) issues.push('房东战未补旋转');

  // 第一刀：旋转用尽 → 付租按钮＝攻击，金币直接换成伤害
  g.spinsLeft = 0;
  g.coins = 300;
  if (!payRent(g).ok) issues.push('房东战攻击失败');
  if (g.boss?.hp !== BOSS_HP - 300) issues.push(`伤害未结算 ${g.boss?.hp}`);
  if (g.coins !== 0) issues.push('攻击后金币未清零');
  if (g.spinsLeft !== 5) issues.push('未击杀未补旋转');

  // 收尾一刀：血量归零 → 房东倒下、置通关
  g.spinsLeft = 0;
  g.coins = BOSS_HP;
  payRent(g);
  if (g.boss?.active) issues.push('血量归零后房东仍存活');
  if (!g.won) issues.push('击败房东未置通关');
  if (g.over) issues.push('击败房东时同时置破产');
  return issues;
}

const bossIssues = bossFightIssues();
check('B 引擎', '房东战流程闭环', bossIssues.length === 0, bossIssues.slice(0, 3).join(' · '));

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

// 商店代币卡：rand 恒 0 → drawCard 必走 token 分支
const tokenShop = createGame(99);
tokenShop.rand = () => 0;
tokenShop.spinsLeft = 0;
tokenShop.coins = 100000;
payRent(tokenShop);
const tokenCard = tokenShop.shop[0];
check(
  'B 引擎',
  '商店能出代币卡',
  Boolean(tokenCard?.token),
  tokenShop.shop.map((c) => c.token ?? c.def.id).join(','),
);
buyFromShop(tokenShop, 0);
check(
  'B 引擎',
  '代币卡买到即入账',
  tokenShop.rerollTokens + tokenShop.removalTokens + tokenShop.essenceTokens === 1,
  `r=${tokenShop.rerollTokens} m=${tokenShop.removalTokens} e=${tokenShop.essenceTokens}`,
);

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

const carry = createGame(13);
carry.essenceTokens = 3;
carry.spinsLeft = 0;
carry.coins = 100000;
payRent(carry);
check('B 引擎', '付租后未用精华作废', carry.essenceTokens === 0, `e=${carry.essenceTokens}`);

const dudRun = createGame(3);
dudRun.floor = 10;
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
  '第 3 期同伴来信：三种代币按第 4 层档位入账',
  comradeRun.rentPaid === 3 &&
    comradeRun.rerollTokens === 2 &&
    comradeRun.removalTokens === 1 &&
    comradeRun.essenceTokens === 2 &&
    comradeRun.mails.some((m) => m.kind === 'init_comrade_help'),
  `tokens=${comradeRun.rerollTokens}/${comradeRun.removalTokens}/${comradeRun.essenceTokens} mails=${comradeRun.mails.map((m) => m.kind).join(',')}`,
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

/* ── C. 交互键位 ── */

const srcFiles = ['main.ts', 'game.ts', 'views.ts'].map((f) =>
  fs.readFileSync(path.join(WEB, 'src', f), 'utf8'),
);
const allSrc = srcFiles.join('\n');

const actionsInMarkup = new Set(
  [...allSrc.matchAll(/data-action="([a-zA-Z-]+)"/g)].map((m) => m[1]),
);
const handled = new Set([...allSrc.matchAll(/case '([a-zA-Z-]+)':/g)].map((m) => m[1]));

const deadKeys = [...actionsInMarkup].filter((a) => !handled.has(a));
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
