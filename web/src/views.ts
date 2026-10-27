import { CELL_COUNT, neighborCounts } from './grid';
import { evaluateCell, identityOf } from './value';
import {
  breakEvenAvgPerSpin,
  compareShuffleVsDraw,
  observeRarity,
  simulateRentPath,
  type ShuffleVsDraw,
} from './experiments';
import { effectCoverage, symbolCoverage } from './effects';
import { symbolName } from './names';
import type { CheckResult } from './selfcheck';
import type { Cell, Rarity } from './types';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const pct = (n: number, d = 1): string => `${(n * 100).toFixed(d)}%`;
const money = (n: number): string => n.toLocaleString('en-US');

export interface FormulaState {
  value: number;
  valueBonus: number;
  valueMultiplier: number;
  permanentBonus: number;
  permanentMultiplier: number;
  prevCount: number;
  negativeCase: boolean;
}

export interface DistState {
  S: number;
  trials: number;
}

/* ────────────────────────────── 公式实验 ────────────────────────────── */

export function renderFormula(state: FormulaState): string {
  const cellBase: Cell = {
    uid: 0,
    def: {
      id: 'probe',
      value: state.value,
      values: [],
      rarity: 'common',
      groups: [],
      sfx: [],
    },
    valueBonus: state.valueBonus,
    valueMultiplier: state.valueMultiplier,
    permanentBonus: state.permanentBonus,
    permanentMultiplier: state.permanentMultiplier,
    prev: [],
    destroyed: false,
    lastOutput: 0,
  };
  const prev = Array.from({ length: state.prevCount }, () => ({ ...identityOf(cellBase) }));
  const probe: Cell = { ...cellBase, prev };
  const bd = evaluateCell(probe);
  const cur = bd.parts[0];
  const prevSum = bd.final - cur.final;
  const skipped = cur.multiplierSkipped;

  const field = (key: keyof FormulaState, label: string, hint: string) => `
    <div class="field">
      <div><label>${label}</label><span class="hint">${hint}</span></div>
      <input type="number" data-f="${key}" value="${state[key]}" step="0.5" />
    </div>`;

  return `
  <div class="formula">
    <div class="panel">
      <h2>单格参数</h2>
      ${field('value', 'value', '基础值，恒定不回写（§4.4）')}
      ${field('valueBonus', 'value_bonus', '本轮加算，结算后清空')}
      ${field('valueMultiplier', 'value_multiplier', '本轮乘算，结算后清空')}
      ${field('permanentBonus', 'permanent_bonus', '永久加算，线性累加')}
      ${field('permanentMultiplier', 'permanent_multiplier', '永久乘算，单调不减')}
      ${field('prevCount', 'prev_data 身份数', '同一格叠置的历史身份，逐份独立结算')}
      <div class="controls">
        <button class="btn ghost" data-action="formula-neg">载入负值样例</button>
        <button class="btn ghost" data-action="formula-reset">复位</button>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2>逐步计算</h2>
        <div class="breakdown">
          <div><span class="op">base</span> = value + value_bonus + permanent_bonus</div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= ${cur.base}</div>
          <div style="margin-top:8px"><span class="op">raw</span> = base × value_multiplier × permanent_multiplier</div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= ${cur.raw}</div>
          <div style="margin-top:8px"><span class="op">final</span> = round(raw) + Σ round(prev)</div>
          <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= ${cur.final} + ${prevSum} </div>
        </div>
        <div style="margin-top:14px"><span class="big">${bd.final}</span>
          <span class="muted small">本格产出</span></div>
        ${skipped
          ? `<div class="note" style="margin-top:10px;color:var(--gold)">
               负值保护生效：raw &lt; 0，跳过全部乘数，仅取 base = ${cur.base}（§4.2）
             </div>`
          : ''}
      </div>

      <div class="panel">
        <h2>对照：负值参与乘算的错误模型</h2>
        <div class="compare">
          <div class="box right">
            <div class="t">源码行为（跳过乘数）</div>
            <div class="n" style="color:var(--green)">${bd.final}</div>
          </div>
          <div class="box wrong">
            <div class="t">错误模型 round(raw)</div>
            <div class="n" style="color:var(--red)">${bd.wrongIfNegativeMultiplied}</div>
          </div>
        </div>
        <div class="note" style="margin-top:12px">
          两模型仅在 <strong>raw &lt; 0</strong> 时出现差异。该保护使「负值符号 × 全局乘数」不构成自毁，
          为 §4.2 的设计要点。
        </div>
      </div>
    </div>
  </div>`;
}

/* ────────────────────────────── 分布实验 ────────────────────────────── */

export function renderDist(state: DistState): string {
  const cmp: ShuffleVsDraw = compareShuffleVsDraw(state.S, state.trials, 20261027);
  const counts = neighborCounts();
  const fanIn = counts.reduce((a, b) => a + b, 0) / CELL_COUNT;
  const rarity = observeRarity(5, 60000);
  const path = simulateRentPath(47.52);
  const breakEven = breakEvenAvgPerSpin();

  const rowHtml = rarity
    .map(
      (r) => `<tr>
        <td>${r.rarity}</td>
        <td class="num">${pct(r.expected, 2)}</td>
        <td class="num">${pct(r.measured, 2)}</td>
        <td class="num ${Math.abs(r.delta) < 0.005 ? 'pass' : 'fail'}">${r.delta > 0 ? '+' : ''}${(r.delta * 100).toFixed(2)}pp</td>
      </tr>`,
    )
    .join('');

  const stageHtml = path.stages
    .map(
      (s) => `<tr>
        <td class="num">${s.payment}</td>
        <td class="num">${money(s.rent)}</td>
        <td class="num">${s.spins}</td>
        <td class="num">${s.needPerSpin.toFixed(2)}</td>
        <td class="${s.affordable ? 'pass' : 'fail'}">${s.affordable ? '可付' : '不足'}</td>
      </tr>`,
    )
    .join('');

  return `
  <div class="panel">
    <h2>实验一：洗牌 vs 有放回抽取（§3.2）</h2>
    <div class="field">
      <div><label>池大小 S</label><span class="hint">20 = 恰好填满可视格；池越大，单个符号出现概率越低</span></div>
      <input type="number" data-f="S" value="${state.S}" min="20" max="200" step="1" />
    </div>
    <div class="compare" style="margin-top:16px">
      <div class="box right">
        <div class="t">洗牌模型 P = 20/S</div>
        <div class="n" style="color:var(--green)">${pct(cmp.shuffleTheory)}</div>
        <div class="note small">蒙特卡洛 ${pct(cmp.shuffleMeasured, 2)}（${state.trials.toLocaleString('en-US')} 次）</div>
      </div>
      <div class="box wrong">
        <div class="t">抽取模型 1-(1-1/S)²⁰</div>
        <div class="n" style="color:var(--red)">${pct(cmp.drawTheory)}</div>
        <div class="note small">蒙特卡洛 ${pct(cmp.drawMeasured, 2)}（${state.trials.toLocaleString('en-US')} 次）</div>
      </div>
    </div>
    <div class="note" style="margin-top:14px">
      S=${state.S} 时两模型相差 <strong>${cmp.gapPp.toFixed(1)} 个百分点</strong>。
      v3.0 将 <span class="mono">P = 20/S</span> 解释为抽取概率，其实际语义为洗牌命中率；
      采用抽取模型会系统性低估高价值符号的覆盖率。
    </div>
  </div>

  <div class="panel">
    <h2>实验二：稀有度抽样 vs 数据表（§6.1）</h2>
    <table class="data">
      <thead><tr><th>档位</th><th>表内概率</th><th>实测（60,000 次）</th><th>偏差</th></tr></thead>
      <tbody>${rowHtml}</tbody>
    </table>
    <div class="note" style="margin-top:12px">
      以第 5 期符号档位（69/29/1.5/0.5）抽样 60,000 次；累积阈值自 very_rare 起算，common 为兜底档，不参与判定。
    </div>
  </div>

  <div class="panel">
    <h2>实验三：恒定 47.52 金币/旋转的通关路径（§7.3）</h2>
    <div class="note" style="margin-bottom:12px">
      二分求解的最低恒定产出：<strong class="mono">${breakEven.toFixed(2)}</strong> coins/spin
      （理论 4277/90 = 47.52）。下表按该产出逐期滚动，余额结转（§7.6）。
    </div>
    <table class="data">
      <thead><tr><th>期</th><th>租金</th><th>可得旋转</th><th>该期所需 / 旋转</th><th>结果</th></tr></thead>
      <tbody>${stageHtml}</tbody>
    </table>
  </div>

  <div class="panel">
    <h2>实验四：8 邻域扇入（§9）</h2>
    <div class="compare">
      <div class="box right">
        <div class="t">8 邻域平均扇入</div>
        <div class="n" style="color:var(--green)">${fanIn.toFixed(2)}</div>
        <div class="note small">角 4 格 ×3 / 边 10 格 ×5 / 内 6 格 ×8</div>
      </div>
      <div class="box wrong">
        <div class="t">4 邻域（v3.0 模型）</div>
        <div class="n" style="color:var(--red)">${(80 / 20).toFixed(2)}</div>
        <div class="note small">角 4×2 / 边 10×3 / 内 6×4 = 4.00</div>
      </div>
    </div>
    <div class="note" style="margin-top:12px">
      计入对角邻接后，平均扇入由 4.00 提高至 ${fanIn.toFixed(2)}（+${((fanIn / 4 - 1) * 100).toFixed(0)}%），
      依赖邻接的符号强度上限随之提高。
    </div>
  </div>`;
}

/* ────────────────────────────── 自检 ────────────────────────────── */

export function renderChecks(results: readonly CheckResult[]): string {
  const groups = [...new Set(results.map((r) => r.group))];
  const pass = results.filter((r) => r.pass).length;
  const allOk = pass === results.length;

  const sections = groups
    .map((g) => {
      const rows = results.filter((r) => r.group === g);
      return `
      <div class="panel">
        <h2>${g}　<span class="tag ${rows.every((r) => r.pass) ? 'good' : 'warn'}">${rows.filter((r) => r.pass).length}/${rows.length}</span></h2>
        <table class="data">
          <thead><tr><th>断言</th><th>期望</th><th>实际</th><th>出处</th><th></th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr>
                  <td>${esc(r.name)}</td>
                  <td class="num muted">${esc(r.expected)}</td>
                  <td class="num">${esc(r.actual)}</td>
                  <td class="muted small">${esc(r.ref)}</td>
                  <td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? '✓' : '✗'}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
    })
    .join('');

  return `
  <div class="panel" style="margin-bottom:18px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div>
        <div class="big" style="color:${allOk ? 'var(--green)' : 'var(--red)'}">${pass}/${results.length}</div>
        <div class="note">全部断言由 <span class="mono">data/*.csv</span> 与引擎实时计算，等价于 <span class="mono">analysis/verify.py</span> 的输出。</div>
      </div>
      <div class="badge ${allOk ? 'ok' : 'bad'}"><span class="dot"></span>${allOk ? '与数据表一致' : '存在不一致'}</div>
    </div>
  </div>
  ${sections}`;
}

/* ────────────────────────────── 说明 ────────────────────────────── */

export function renderAbout(): string {
  return `
  <div class="panel">
    <h2>验证范围</h2>
    <div class="note">
      本页不复刻游戏本体，而是将 <span class="mono">docs/</span> 中的结论对象化为可执行断言：
      可公式化或可断言者在此逐条执行；分析中标注为未覆盖者，此处不做补充推演。
    </div>
    <table class="data" style="margin-top:14px">
      <thead><tr><th>结论</th><th>验证方式</th><th>位置</th></tr></thead>
      <tbody>
        <tr><td>租金合计 4,277 / 旋转 90</td><td>逐期表求和 + 增量公式比对</td><td class="muted">自检 · 租金</td></tr>
        <tr><td>通关门槛 47.52 coins/spin</td><td>二分求解 + 逐期滚动模拟</td><td class="muted">分布实验 · 三</td></tr>
        <tr><td>旋转为洗牌而非抽取</td><td>蒙特卡洛对比两模型命中率</td><td class="muted">分布实验 · 一</td></tr>
        <tr><td>稀有度无保底机制</td><td>抽样频率回列表内概率</td><td class="muted">分布实验 · 二</td></tr>
        <tr><td>邻接为 8 邻域</td><td>几何计数：角 3 / 边 5 / 内 8</td><td class="muted">分布实验 · 四</td></tr>
        <tr><td>先加后乘，负值不参与乘算</td><td>单格参数化 + 正确/错误模型对照</td><td class="muted">公式实验</td></tr>
        <tr><td>永久乘数跨轮复利</td><td>permanent_multiplier 连乘后取整</td><td class="muted">公式实验</td></tr>
      </tbody>
    </table>
  </div>

  <div class="panel">
    <h2>口径之外的部分</h2>
    <div class="note">
      <strong>符号效果按声明逐条接入。</strong><span class="mono">Slot_Icon__Slot_Icon.gd</span> 的
      <span class="mono">add_effect</span> 声明由 <span class="mono">analysis/lbal_effect_rules.py</span> 解析成表，
      数值槽、布尔槽、谓词全部落到真实字段；<span class="mono">add_effect_to_symbol</span> 走相邻协同，
      <span class="mono">destroyed</span> 按「先挂 tbd、转完落地」两段式执行。
    </div>
    <div class="note" style="margin-top:10px">
      <strong>道具与精华。</strong>114 个道具与 113 个精华共用同一套声明式结算，
      <span class="mono">Item__Item.gd</span> 的分支与符号侧走同一个解释器。
    </div>
    <div class="note" style="margin-top:10px">
      <strong>Fine Print 细则。</strong>37 条细则已进表。它们的作用是改写别的符号的判定入口，
      属于结算前的口径调整，接入前不改变任何一格的数值。
    </div>
    <div class="note" style="margin-top:10px">
      <strong>难度曲线。</strong>租金合计 4,277 / 90 旋转，由 <span class="mono">analysis/rent-model.ts</span> 逐期断言。
      240 局基线里破产落在第 3–10 期，通关的局需要靠相邻协同与销毁链把每转产出翻上去——
      输赢由牌序与买法决定，不是数值上注定。
    </div>
    <div class="note" style="margin-top:10px">
      <strong>美术素材。</strong>不复用原版贴图与音效，改用 Emoji 与自绘样式，以规避素材版权问题。
    </div>
  </div>

  <div class="panel">
    <h2>数据与构建</h2>
    <div class="note">
      所有数值来自 <span class="mono">data/*.csv</span>，由 <span class="mono">web/scripts/gen-data.mjs</span>
      在构建时编译成 JSON，页面不含手写常量。产物为纯静态文件，可直接托管于 GitHub Pages。
    </div>
    <div class="note" style="margin-top:10px">
      <strong>展示名。</strong>源码以内部键命名符号（<span class="mono">d5</span>、<span class="mono">item_capsule</span> 等），
      直接呈现不利于阅读。展示名统一映射于 <span class="mono">web/src/names.ts</span>，对局界面仅使用该层；
      详情面板与效果声明同时标注原始 id，便于与源码对照。
    </div>
    <div class="note" style="margin-top:10px">
      <strong>关于 §。</strong>分析面板中的 <span class="mono">§x.y</span> 为
      《Luck-be-a-Landlord 源码级机制分析》的章节编号，用于回溯推导过程；对局界面不出现章节编号。
    </div>
    <table class="data" style="margin-top:14px">
      <thead><tr><th>文件</th><th>作用</th></tr></thead>
      <tbody>
        <tr><td class="mono">symbols.csv</td><td>168 符号的基础值、效果参数、分组</td></tr>
        <tr><td class="mono">source_rent.csv</td><td>12 期租金、楼层门槛、旋转增量</td></tr>
        <tr><td class="mono">source_rarity.csv</td><td>符号/道具两套四档概率（逐期）</td></tr>
        <tr><td class="mono">items.csv / essences.csv</td><td>114 道具 / 113 精华</td></tr>
        <tr><td class="mono">fine_print.csv</td><td>37 条全局规则修正</td></tr>
      </tbody>
    </table>
  </div>`;
}

/* ────────────────────────────── 还原对照 ────────────────────────────── */

interface Mechanism {
  name: string;
  src: string;
  state: 'done' | 'part' | 'todo';
  note: string;
}

const MECHANISMS: Mechanism[] = [
  {
    name: '棋盘 5 列 × 5 槽，槽 0 在屏幕外',
    src: 'Main__Reels.gd:8-9 · Main__Main.gd:1237',
    state: 'done',
    note: '可视 4 行共 20 格；槽 0 仅参与洗牌。',
  },
  {
    name: '旋转 = 收集全部槽 → 洗牌 → 回填 → 屏幕外交换',
    src: 'Main__Reels.gd:368-428',
    state: 'done',
    note: '旋转为洗牌而非抽取；池内空位剔除至 ≤ 25。',
  },
  {
    name: '开局每列一个基础符号，并按楼层注入 dud',
    src: 'Reel__Reel.gd:277-298',
    state: 'part',
    note: '基础符号已还原；floor ≥ 5 / 7 的 dud 注入尚未接入。',
  },
  {
    name: '初始 1 金币 / 首期租金 25 / 5 次旋转',
    src: 'Main__Main.gd:1277 · 1286',
    state: 'done',
    note: 'rent_values = [25, 5]',
  },
  {
    name: '付租后旋转数 += 5 + floor(已付次数/2)',
    src: 'Pop-up__Pop-up.gd:2882-2890',
    state: 'done',
    note: '余额结转，不清零。',
  },
  {
    name: '商店 3 选 1，稀有度按付租次数强制配比',
    src: 'Pop-up__Pop-up.gd:2657-2684',
    state: 'done',
    note: '付租 ≤ 5 次全为 uncommon，≥ 10 次全为 rare；非随机抽取。',
  },
  {
    name: 'add_effect 声明 → 条件成立时改目标属性',
    src: 'Slot_Icon__Slot_Icon.gd:3087-3323',
    state: 'done',
    note: '二十余个属性槽位与全部条件谓词均在 effects.ts 的 applyTo / matchOne 中映射。',
  },
  {
    name: 'add_effect_to_symbol：效果挂到相邻符号',
    src: 'Slot_Icon__Slot_Icon.gd:1374-1381',
    state: 'done',
    note: '条件在挂载目标的邻域内判定。',
  },
  {
    name: '无 type/groups 比较时自动补「同类相邻」条件',
    src: 'Slot_Icon__Slot_Icon.gd:3220-3221',
    state: 'done',
    note: 'withAutoComparisons 在入口前置补 {a:"type", b:自身} 条件，跳过 unconditional / from_item / 特定 giver。',
  },
  {
    name: 'destroyed 效果自动补「不可破坏 = false」条件',
    src: 'Slot_Icon__Slot_Icon.gd:3222-3229',
    state: 'done',
    note: 'Cell.indestructible 参与条件判定，销毁分支同时挡下不可破坏目标。',
  },
  {
    name: '每轮单次扫描（效果不连锁迭代）',
    src: 'Slot_Icon__Slot_Icon.gd:3330+',
    state: 'done',
    note: '源码每轮只遍历一次 add_effects，本引擎同序执行。',
  },
  {
    name: 'fine_print 细则道具',
    src: 'data/fine_print.csv',
    state: 'part',
    note: '37 条细则已进表；它们改写的是别的符号的判定，接入前不影响结算。',
  },
  {
    name: '美术与音效',
    src: '—',
    state: 'done',
    note: '不使用原版素材，改为 Emoji + 自绘样式，随包离线可用。',
  },
];

const STATE_LABEL: Record<Mechanism['state'], string> = {
  done: '已还原',
  part: '部分还原',
  todo: '尚未接入',
};

export function renderRestore(): string {
  const cov = effectCoverage();
  const symbols = symbolCoverage();
  const share = cov.effective ? (cov.executable / cov.effective) * 100 : 0;
  const none = symbols.filter((s) => s.executable === 0);

  const vtcLabel = (k: string): string =>
    k === '<空>' ? 'value_to_change 为空（增删道具/方块类声明）' : `属性 ${k}`;
  const predLabel = (k: string): string =>
    k === '[object Object]' || k === 'null' ? '条件字段由运行时决定' : `条件 ${k}`;
  const reasons = [
    ...cov.unsupportedVtc.map(([k, n]) => [vtcLabel(k), n] as const),
    ...cov.unsupportedPred.map(([k, n]) => [predLabel(k), n] as const),
  ].sort((a, b) => b[1] - a[1]);

  const mechRows = MECHANISMS.map(
    (m) => `<tr>
      <td>${esc(m.name)}</td>
      <td class="mono muted small">${esc(m.src)}</td>
      <td class="${m.state === 'done' ? 'pass' : m.state === 'part' ? 'warn' : 'fail'}">${STATE_LABEL[m.state]}</td>
      <td class="muted small">${esc(m.note)}</td>
    </tr>`,
  ).join('');

  const reasonRows = reasons
    .map(([label, n]) => `<tr><td>${esc(label)}</td><td class="num">${n}</td></tr>`)
    .join('');

  const noneList = none
    .slice(0, 24)
    .map((s) => `<span class="tag warn">${esc(symbolName(s.id))}</span>`)
    .join(' ');

  return `
  <div class="panel">
    <h2>声明执行率</h2>
    <div class="compare">
      <div class="box right">
        <div class="t">参与结算的 add_effect 声明</div>
        <div class="n" style="color:var(--green)">${cov.executable} / ${cov.effective}</div>
        <div class="note small">${share.toFixed(1)}% · 覆盖 ${cov.symbols} 个符号 · 另有 ${cov.noop} 条判定分支不产生数值</div>
      </div>
      <div class="box wrong">
        <div class="t">细则门控（未激活）</div>
        <div class="n" style="color:var(--red)">${cov.gated}</div>
        <div class="note small">这些声明只在对应 fine_print 细则生效时结算，属源码设计的分支条件</div>
      </div>
    </div>
    <div class="note" style="margin-top:12px">
      分母为 <span class="mono">analysis/lbal_effect_rules.py</span> 自
      <span class="mono">Slot_Icon__Slot_Icon.gd</span> 解析出的全部声明；分子为解释器实际参与结算的条数。
      属性槽位与条件谓词经 <span class="mono">effects.ts</span> 的 <span class="mono">applyTo</span> /
      <span class="mono">matchOne</span> 全量映射，没有留空分支。
    </div>
  </div>

  <div class="panel">
    <h2>非结算声明分布</h2>
    <table class="data">
      <thead><tr><th>原因</th><th>声明条数</th></tr></thead>
      <tbody>${reasonRows || '<tr><td colspan="2" class="muted">无</td></tr>'}</tbody>
    </table>
    <div class="note" style="margin-top:12px">
      源码 <span class="mono">Slot_Icon.gd</span> 未给 <strong>${none.length}</strong> 个可放置物写
      <span class="mono">add_effect</span> 分支，它们按基础值结算、不读写相邻符号：
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${noneList || '<span class="muted">无</span>'}</div>
    </div>
  </div>

  <div class="panel">
    <h2>机制对照表</h2>
    <table class="data">
      <thead><tr><th>机制</th><th>源码位置</th><th>状态</th><th>说明</th></tr></thead>
      <tbody>${mechRows}</tbody>
    </table>
  </div>`;
}

export type { Rarity };
