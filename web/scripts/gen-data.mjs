// 把仓库 ../data 下的 CSV（分析结论表）编译成网页可直接 import 的 JSON。
// 不手抄任何数值：所有数字都来自 docs 配套的数据表。
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const DATA_DIR = path.resolve(HERE, '../../data');
const OUT_DIR = path.resolve(HERE, '../src/data');

/** 支持双引号转义的极简 CSV 解析 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function readObjects(name) {
  const file = path.join(DATA_DIR, name);
  const [head, ...rest] = parseCSV(fs.readFileSync(file, 'utf8'));
  return rest.map((cells) => {
    const obj = {};
    head.forEach((k, idx) => {
      obj[k.trim()] = (cells[idx] ?? '').trim();
    });
    return obj;
  });
}

/** Python 字面量列表 -> JS 数组：['a', 'b'] / [1, 2] / [] */
function pyList(raw) {
  const s = (raw ?? '').trim();
  if (!s || s === '[]') return [];
  const asJson = s.replace(/'/g, '"');
  try {
    const v = JSON.parse(asJson);
    return Array.isArray(v) ? v : [];
  } catch {
    return s
      .slice(1, -1)
      .split(',')
      .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
}

const num = (v) => Number.parseFloat(v) || 0;

function buildSymbols() {
  return readObjects('symbols.csv').map((r) => ({
    id: r.id,
    value: Math.trunc(num(r.value)),
    values: pyList(r.values).map((x) => Math.trunc(Number(x) || 0)),
    // 空 rarity 表示该符号不进入任何商店池（dud / empty / 骰子变体等）
    rarity: r.rarity,
    groups: pyList(r.groups),
    sfx: pyList(r.sfx),
  }));
}

/**
 * 精华与道具同构：都是可放置物（Item__Item.gd 同一套 add_effect 分支），
 * 基础 value 为 0，产出全部来自各自声明；rarity 记为 essence，不进符号池。
 */
function buildPool(name, effectsById) {
  return readObjects(name).map((r) => {
    const effects = effectsById?.get(r.id) ?? [];
    return {
      id: r.id,
      value: 0,
      values: pyList(r.values).map((x) => Math.trunc(Number(x) || 0)),
      rarity: r.rarity || 'common',
      groups: pyList(r.groups),
      sfx: [],
      kind: 'item',
      effects: effects.map((e, i) => ({ i, ...e })),
    };
  });
}

/** 道具的声明效果（analysis/lbal_item_rules.py 产出） */
function itemEffects() {
  const map = new Map();
  for (const r of readObjects('item_effects.csv')) {
    const flags = r.flags ? r.flags.split(';') : [];
    const kind = flags.find((f) => f.startsWith('kind:'))?.slice(5) ?? 'self';
    const rule = {
      symbol: r.item,
      branchLine: Number.parseInt(r.branch_line, 10) || 0,
      line: Number.parseInt(r.line, 10) || 0,
      comparisons: JSON.parse(r.comparisons || '[]'),
      vtc: r.vtc || '',
      diff: JSON.parse(r.diff || 'null'),
      kind,
      flags: flags.filter((f) => !f.startsWith('kind:')),
    };
    // 源码里多个道具共用同一段分支（`"pool_ball", "horseshoe", "bowling_ball", ...:`），
    // 解析后 item 记作 `a|b|c`；必须按 id 拆开登记，否则这些道具查不到自己的声明。
    for (const id of String(r.item).split('|')) {
      const key = id.trim();
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(rule);
      map.set(key, list);
    }
  }
  return map;
}

/**
 * 道具是可放置物，与符号共用同一套格子/结算管线。
 * 基础 value 为 0：道具的产出全部来自它自己的声明效果
 * （Item__Item.gd:532-540 get_value 的初值是 0，靠 add_effect 累加）。
 */
function buildItems(effectsByItem) {
  return readObjects('items.csv').map((r) => {
    const effects = effectsByItem.get(r.id) ?? [];
    return {
      id: r.id,
      value: 0,
      values: pyList(r.values).map((x) => Number(x) || 0),
      // 空 rarity = 不进入商店（精华、特殊道具）
      rarity: r.rarity || '',
      groups: pyList(r.groups),
      sfx: [],
      kind: 'item',
      effects: effects.map((e, i) => ({ i, ...e })),
    };
  });
}

function buildFinePrint() {
  return readObjects('fine_print.csv').map((r) => ({
    id: Number.parseInt(r.id, 10),
    difficulty: Number.parseInt(r.difficulty, 10) || 0,
    reliantTypes: pyList(r.reliant_types),
    reliantGroups: pyList(r.reliant_groups),
    values: pyList(r.values).map((x) => Math.trunc(Number(x) || 0)),
  }));
}

function buildRent() {
  return readObjects('source_rent.csv').map((r) => {
    const threshold = (r.floor_threshold || '').split(':');
    return {
      payment: Number.parseInt(r.payment, 10),
      rent: Number.parseInt(r.rent, 10),
      floorGate: threshold.length === 2
        ? { floor: Number.parseInt(threshold[0], 10), bonus: Number.parseInt(threshold[1], 10) }
        : null,
      spinsGain: Number.parseInt(r.spins_after_payment, 10),
      spinsCumulative: Number.parseInt(r.spins_cumulative, 10),
    };
  });
}

function buildRarity() {
  const rows = readObjects('source_rarity.csv').map((r) => ({
    payment: Number.parseInt(r.payment, 10),
    kind: r.kind,
    common: num(r.common),
    uncommon: num(r.uncommon),
    rare: num(r.rare),
    veryRare: num(r.very_rare),
  }));
  return {
    symbol: rows.filter((r) => r.kind === 'symbol'),
    item: rows.filter((r) => r.kind === 'item'),
  };
}

/** add_effect 声明（analysis/lbal_effect_rules.py 产出） */
function buildEffects() {
  return readObjects('effects.csv').map((r, i) => ({
    i,
    symbol: r.symbol,
    branchLine: Number.parseInt(r.branch_line, 10) || 0,
    line: Number.parseInt(r.line, 10) || 0,
    comparisons: JSON.parse(r.comparisons || '[]'),
    vtc: r.vtc || '',
    diff: JSON.parse(r.diff || 'null'),
    kind: 'self',
    flags: r.flags ? r.flags.split(';') : [],
  }));
}

const symbols = buildSymbols();
const itemEffectMap = itemEffects();
const items = buildItems(itemEffectMap);
const essences = buildPool('essences.csv', itemEffectMap);
const finePrint = buildFinePrint();
const rent = buildRent();
const rarity = buildRarity();
const effects = buildEffects();

fs.mkdirSync(OUT_DIR, { recursive: true });

const write = (name, data) => {
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
  const kb = (JSON.stringify(data).length / 1024).toFixed(1);
  console.log(`  ${name.padEnd(16)} ${String(data.length ?? 0).padStart(4)} 条  ${kb} KB`);
};

console.log('从 data/ 编译数据分析表：');
write('symbols.json', symbols);
write('items.json', items);
write('essences.json', essences);
write('finePrint.json', finePrint);
write('rent.json', rent);
write('rarity.json', rarity);
write('effects.json', effects);

const withRarity = symbols.filter((s) => s.rarity);
console.log(`\n统计：符号 ${symbols.length}（${withRarity.length} 个带稀有度）`
  + ` / 道具 ${items.length} / 精华 ${essences.length} / 细则 ${finePrint.length}`
  + ` / 租金 ${rent.length} 期`);
console.log(`租金合计 ${rent.reduce((a, r) => a + r.rent, 0)}，spins 累计 ${rent.at(-1).spinsCumulative}`);
