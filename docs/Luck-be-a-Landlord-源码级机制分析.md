# Luck be a Landlord —— 源码级机制分析（v4.0）

> 本文档是**纯学术机制分析**，不含、也不分发原作品的任何代码、资源或可执行文件。
>
> - 研究对象：《Luck be a Landlord》（Godot 3 导出，移动端）
> - 分析材料：41 段游戏脚本（26,583 行）＋ 5 份资源 JSON，**本地保存，不入库**
> - 入库内容：仅本文档与 `data/` 下的数值结论表（租金、概率、符号/道具/精华/细则属性）
> - 修订对象：`docs/Luck-be-a-Landlord-算法与机制整理.md` v3.0（其 §3.1、§A.4 保底、附录 F.6 被本文推翻）

---

## 目录

1. [材料与方法](#1-材料与方法)
2. [工程结构：脚本藏在哪里](#2-工程结构脚本藏在哪里)
3. [一局的生命周期](#3-一局的生命周期)
4. [数值管线](#4-数值管线)
5. [效果系统：声明式规则表](#5-效果系统声明式规则表)
6. [稀有度与抽取](#6-稀有度与抽取)
7. [租金与旋转供给](#7-租金与旋转供给)
8. [难度缩放](#8-难度缩放)
9. [对既有结论的修订](#9-对既有结论的修订)
10. [可复现性](#10-可复现性)

---

## 1. 材料与方法

### 1.1 包结构观察

研究对象的安装包采用 Godot 3 的标准导出布局（体积数据为观察值，文件本体不入库）：

```
<package>
├── lib/*/libgodot_android.so        Godot 运行时，不含游戏逻辑
├── classes*.dex                     androidx 与广告/统计 SDK，不含游戏逻辑
└── assets/
    ├── JSON/*.json                  数据表（符号/道具/精华/邮件/细则）
    ├── *.tscn                       场景，「脚本以内嵌 sub_resource 形式存在」
    ├── *.gdc                        少量字节码（mod 加载器）
    └── project.binary               工程配置
```

结论：**机制逻辑不分布在 Android 层（dex / so），而集中在 `assets/` 的场景与数据表中。**

### 1.2 脚本载体：场景内嵌资源

Godot 3 允许把脚本作为场景的 `sub_resource` 内联保存；导出为文本场景后，脚本正文以明文形式随场景一起写出：

```
[sub_resource type="GDScript" id=N]
script/source = "<脚本全文；换行为真实换行，非转义序列>"
```

据此可在**本地**取得可读源码用于事实核对（41 段 / 26,583 行 / 全部明文）。**提取产物、提取工具、以及原包本体均不入库**，仅保存在作者本地（见 `.gitignore` 与 §10.1）。

### 1.3 证据等级

| 标记 | 含义 |
|---|---|
| **A** | 已在源码层面核对，行号可追溯 |
| **A−** | 源码可读，但语义需结合数据表解释 |
| **B** | 源码中存在的常量/默认值，其影响未全量穷举 |
| **待复核** | 本文档未完成覆盖，明确标注 |

### 1.4 模块规模（代码度量，不含代码内容）

> 下列为各模块的行数度量，用于说明逻辑的分布密度；对应源文件不入库。

| 行数 | 文件 | 职责 |
|---|---|---|
| 4,720 | `Slot_Icon__Slot_Icon.gd` | 单格符号：取值、邻接、效果声明、动画 |
| 3,511 | `Pop-up__Pop-up.gd` | 租金、稀有度、抽取、商店 UI |
| 2,836 | `Main__Main.gd` | 全局状态、数据库、存档 |
| 2,553 | `Options__Options.gd` | 设置与本地化 |
| 2,363 | `Item__Item.gd` | 114 道具 + 113 精华的效果实现 |
| 2,044 | `Main__Reels.gd` | 旋转、效果收敛、结算、收尾 |
| 6,556 | 其余 35 段 | UI 组件（Card / Reel / Tooltip / Stats…） |

---

## 2. 工程结构：脚本藏在哪里

### 2.1 节点树（运行时单例）

```
/root/Main                    Main.gd     全局状态：coins、difficulty、数据库
├── Reels                     Reels.gd    5 列 × 4 行网格、旋转、结算
├── Items                     Item.gd     已持有道具/精华
├── Landlord                  Landlord.gd 租金、fine_print（37 条细则）
├── Pop-up Sprite/Pop-up      Pop-up.gd   商店、稀有度、租金推进
├── Coin Sum                  Coins.gd    金币池与动画队列
└── …（Sprite / Sound / Stats / Achievement）
```

关键：节点通过绝对路径互相访问（`$"/root/Main/Items".has_unmodded_item(...)`），**没有依赖注入**，因此任何组件都能读全局状态 —— 这也是效果 DSL 能任意查询道具/租金细则的原因。

### 2.2 网格几何

| 常量 | 值 | 出处 |
|---|---|---|
| `reel_width` | 5（列） | `Main__Reels.gd` |
| `reel_height` | 4（行） | `Main__Reels.gd` |
| 单元格像素 | 112 | `Main__Reels.gd:413` |
| 可见格数 | **20** | 5 × 4 |

每一列是一条独立的"卷带"（`reels[reel_num].icons`），格坐标 `grid_position = Vector2(x, y)`，x 为列、y 为行。

---

## 3. 一局的生命周期

### 3.1 初始状态（A）

| 状态 | 值 | 出处 |
|---|---|---|
| 金币 | **1** | `Main__Main.gd:1277` `coins = 1` |
| 租金 / spins | **`[25, 5]`** | `Main__Main.gd:1286` `popup.rent_values = [25, 5]` |
| 期数 | **12** | `Main__Main.gd:1308` `times_to_pay_rent = 12` |
| 初始符号 | **5 个 `coin`** | `Main__Main.gd:1650` `symbols1 = ["coin","coin","coin","coin","coin"]` |
| 初始稀有度加成 | 0 / 0 / 0 | `Main__Main.gd:1304` 附近 |

> 注：`rent_values = [租金, 剩余旋转]` 是本作唯一的经济状态向量。

### 3.2 旋转的本质：**洗牌**，不是抽取

这是 v3.0 文档最需要修正的一点。

`Main__Reels.gd:368-429 shuffle_tiles()`：

1. 把**全部**已有符号（含 `empty` 空格）收进 `pool`，清空各列；
2. 若空格过多，先剔除多余空格（下限 25 个符号，`L386-394`）；
3. `pool.shuffle()`（`L396`）—— **纯随机打乱**；
4. 按 `reels[(i - passes) % reel_width]` 逐列回填（`L404-406`）；
5. 把屏幕外的非空符号与屏幕内的空格**交换**，保证可视区被填满（`L407-426`）。

**结论**：

- 每次旋转**不产生新符号、不销毁符号**，符号集合完全不变；
- 旋转只决定"哪 20 个落入 4×5 可视区"；
- 因此"抽到某个符号"由**玩家资产池**决定，而不是由概率表决定；
- 概率表（§6）只作用于**商店 offer**，作用于"买什么"，不作用于"转出什么"。

数学刻画：设池中符号数 \\(S\\)（含空格），某符号在可视区出现的概率

\[ P(\text{出现}) = \frac{20}{S},\qquad E[\text{同屏份数}] = \frac{20}{S} \]

当 \\(S=145\\)（全图鉴）时约 13.8% —— 与 v3.0 附录 F.4 的数值一致，但**语义完全不同**：那里把它当作"抽取概率"，实际是"洗牌命中率"。

### 3.3 回合流程

```
spin()                       Reels.gd:183-306
  ├─ 注入 dud（难度）        Reels.gd:273-281
  ├─ shuffle_tiles()         重排 20 格
  ├─ 动画滚动结束
  └─ check_effects()         效果收敛（不动点迭代）
       └─ check_values()     读值、汇总、排序显示
            └─ finalize_clumps()  折叠永久值、成就、清理
```

`true_final_value = true`（`Reels.gd:1117`）表示进入"最终取值"阶段 —— 在 `check_effects` 收敛前，`get_value` 走的是**过程值**分支。

---

## 4. 数值管线

### 4.1 `get_value()` 的完整公式（A，`Slot_Icon.gd:1080-1145`)

对单个符号格：

\[
\text{base} = \text{value} + \sum_i \text{value\_bonus}_i + \text{permanent\_bonus}
\]

\[
\text{raw} = \text{base} \times \prod_j \text{value\_multiplier}_j \times \text{permanent\_multiplier}
\]

\[
\text{final} = \operatorname{round}(\text{raw}) + \sum_{p \in \text{prev\_data}} \text{round}(\text{raw}_p)
\]

即 **先加算 → 再乘算 → 四舍五入 → 再加历史身份链**。

### 4.2 负值不吃乘数（A，同函数）

```text
若 raw < 0：
    final = round(value + value_bonus + permanent_bonus) + prev_final_value
```

负数被排除在乘法之外。设计含义：**乘数不能被用来把负债放大成更大的负债**，避免负面效果与乘数类道具产生"恶性联动"。这使得"负值符号 + 全局乘数"成为一个可控组合，而非自毁陷阱。

### 4.3 历史身份链 `prev_data`

`prev_data.push_back(p_obj)`（`Slot_Icon.gd:371`）发生在**同一个格子改变类型时**：旧身份对象被压栈保留，而不是销毁。

后果：一个格子可以同时是"多个符号"，每个历史身份都保留自己的 `permanent_bonus` / `permanent_multiplier`，并在 `get_value` 中各自算一份再相加。

这正是"复制 / 变形 / 叠加"类效果能产生复利的结构基础 —— **份数不是靠新增格子，而是靠给同一格子叠身份**。

### 4.4 永久加成的跨轮复利（A，`Slot_Icon.gd:939-957` / `Reels.gd:1775`）

```text
permanent_bonus      ← permanent_bonus + Δb        （线性累加）
permanent_multiplier ← permanent_multiplier × m    （连乘，只增不减）
```

结算收尾（`Reels.gd:1775-1777`）：

\[
\text{final\_value} = (\text{value} + \text{permanent\_bonus}) \times \text{permanent\_multiplier}
\]

注意 `final_value` **不回写 `value`**：基础值恒定，每次结算都在"基础值 + 累计加成"上乘一次永久乘数。`permanent_multiplier` 只增不减，因此

\[
\text{产出}_n \propto \prod_{k \le n} m_k
\]

**指数增长来自乘数的跨轮累积，而不是单轮内的临时加成。** v3.0 §E.3 用 \\(2^{19}\\) 描述的位置乘算，其源码对应物就是这里的 `permanent_multiplier` 连乘 + `prev_data` 多重身份。

### 4.5 临时数组的生命周期

`value_bonus_arr` / `value_multiplier_arr` 在每次结算后清空（`Reels.gd:1800+`），只有 `permanent_*` 与 `value` 跨轮存活。所以：

| 类型 | 存活期 | 效果 |
|---|---|---|
| `value_bonus_arr` | 单次结算 | 本轮加算 |
| `value_multiplier_arr` | 单次结算 | 本轮乘算 |
| `permanent_bonus` | 永久 | 线性成长 |
| `permanent_multiplier` | 永久 | **复利** |
| `prev_data` | 单次结算（结算后清空） | 多重身份分别计价 |

---

## 5. 效果系统：声明式规则表

### 5.1 结构

符号效果不是硬编码的过程，而是**声明 + 解释**：

- **声明**：`Slot_Icon.gd::add_conditional_effects()`（L3652-4720）按 `match t:` 为每个符号喷出若干 `add_effect({...})` 字典；
- **解释**：`do_diff()`（L1742-2529，788 行）统一执行这些字典。

单条效果字典的字段：

| 字段 | 语义 |
|---|---|
| `comparisons` | 谓词列表，全部满足才触发 |
| `value_to_change` | 被改属性名（36 种） |
| `diff` | 改量（加算或乘算，取决于属性） |
| `one_time` | 是否只触发一次 |
| `anim` / `sfx` | 表现层 |
| `reverse_eff` | 是否可逆（结算后回滚） |
| `item_to_destroy` | 消耗道具 |
| `min_rarity` | 稀有度门槛 |

### 5.2 谓词词汇表（23 种，A）

`self_type`、`adjacent_type`、`adjacent_group`、`adjacent_pos`、`above_type`、`below_type`、`above_self`、`left_of_self`、`self_rarity`、`adjacent_rarity`、`has_item`、`has_unmodded_item`、`self_value`、`adjacent_value`、`adjacent_count`、`self_count`、`self_direction`、`no_adjacent`、`prev_type`、`target_type`、`each_value`、`specific_value`、`transformable`

### 5.3 被改属性词汇表（36 种，A）

产出：`value`、`value_bonus`、`value_multiplier`、`permanent_bonus`、`permanent_multiplier`
身份：`type`、`rarity`、`destroy`、`duplicate`
经济：`coins`、`essence_tokens`、`reroll_tokens`、`removal_tokens`
元数据：`saved_value`、`saved_values`、`displayed_text_value`、`achievement_values` …

### 5.4 触发顺序：不动点迭代（A，`Reels.gd:906-1102`）

```
while true:
    can_break = true
    for pos in symbol_positions_to_update.sorted:
        执行该格所有满足条件的效果
    if 没有任何 changed_value:
        break
```

三条通道驱动下一轮：`symbol_queue`（新增）、`symbol_positions_tbd`（待销毁）、`symbol_positions_to_update`（待更新）。

**这是不动点迭代，不是单次遍历。** 含义：

1. 效果链长度不受"一次扫描"限制，可以无限传播，直到状态稳定；
2. 只要存在自增强循环（A 抬 B、B 又抬 A），理论上会持续到收敛 —— 游戏用"每次改动值不同"作为收敛判据；
3. 因此**"结算顺序"只在同一轮内决定性**，跨轮由队列与排序决定。

排序（`Reels.gd:944`、`960`）对 `Vector2` 位置数组调用 `sort()`。Godot 的 `Vector2` 比较为 lexicographic（先 x 后 y），故遍历顺序是 **列优先、自上而下**，而非行优先。

### 5.5 规模统计（A，据本地源码清点）

| 指标 | 数值 |
|---|---|
| `match` 符号分支 | 125（每个分支可含多个符号别名，如 `"d5", "d3":`） |
| 有专属分支的符号 | **133 / 168** |
| 无专属分支（靠值/组规则生效） | **35**：`coin`、`amethyst`、`bluebird`、`cherry`、`dice1`…`dice5`、`empty`、`omelette`、`wolf` 等 |
| `add_effect` 声明总数 | 276 |

---

## 6. 稀有度与抽取

### 6.1 单格抽取算法（A，`Pop-up.gd:1123-1270 add_cards()`）

```text
u ~ U(0, 1)
u < p_VR                        → very_rare
p_VR ≤ u < p_VR + p_R           → rare
p_VR + p_R ≤ u < p_VR+p_R+p_U   → uncommon
否则                             → common（兜底档，不参与判定）
```

要点：

1. **从最稀有档开始判**，累积阈值向上叠；
2. `r_chances[r] *= rarity_bonuses["symbols"][r]` —— **加成是乘算，且不重新归一化**；
3. 因此提高 rare 加成不会挤占 very_rare 的区间，而是从 `common` 的余量里扣（common 从未参与判定，是"兜底档"）；
4. 池空时回落到相邻档（`card_pool[rarity].size() > 0`）；
5. 默认展示 **3 张**卡（`symbols_to_choose_from = 3`），`shattered_mirror` 减少、`credit_card` 增加。

### 6.2 每期概率（A，`Pop-up.gd:2564-2581`，`data/source_rarity.csv`）

| 已付 | 符号 uncom / rare / VR | → common | 道具 uncom / rare / VR | → common |
|---|---|---|---|---|
| 0 | 0 / 0 / 0 | 1.000 | 0 / 0 / 0 | 1.000 |
| 1 | .10 / 0 / 0 | .900 | .10 / 0 / 0 | .900 |
| 2 | .20 / .01 / 0 | .790 | .20 / .025 / 0 | .775 |
| 3 | .25 / .01 / 0 | .740 | .25 / .025 / 0 | .725 |
| 4 | .29 / .015 / .005 | .690 | .30 / .0375 / .0125 | .650 |
| 5+ | **.30 / .015 / .005** | **.680** | .375 / .05 / .015 | .560 |
| 6+ | 冻结 | .680 | **冻结** | **.560** |

两处修正：

- 符号档位在**第 5 次付租后冻结**，冻结值 30 / 1.5 / 0.5，common = 68% —— 与 wiki 完全一致（**A 级确认**）；
- **道具用的是另一套权重**，第 6 次付租后冻结于 37.5 / 5 / 1.5，common = 56%。符号与道具**不同档**，v3.0 未区分。

### 6.3 不存在"稀有度保底"（A，推翻 wiki）

- 全量搜索 `guarantee` / `pity` / `forced_rarity` 相关逻辑：**无命中**；
- `add_cards()` 是纯独立抽样，无跨轮计数、无"第 N 次必出"分支；
- v3.0 `data/offer_rarity.csv` 中的 `guarantee` 列（`uncommon_plus` / `one_rare_plus` / `two_rare_plus`）**来自 wiki，源码中不存在**，必须删除或标记为"未证实"。

这是本文档最重要的**证伪**结论：v3.0 §6 的推论 3（"稀有度提前冻结 + 保底补偿"）的前提不成立。

### 6.4 稀有度加成的来源

```text
对每个档位 r：p_r ← p_r × bonus_r      （独立乘算，不重新归一化）
```

加成由道具/精华（如 `lucky_cat_essence`）与 fine_print 直接乘在概率上。因为是乘算且不归一化，单个 "+100% rare" 类道具的实际效果是"把 common 的份额削掉 1.5%"，而不是"翻倍 rare 的出现率" —— **在 1.5% 的基数上翻倍，绝对收益只有 1.5 个千分点**。这解释了为什么稀有度类道具在体感上远弱于数值类道具。

---

## 7. 租金与旋转供给

### 7.1 租金表（A，`Pop-up.gd:2559-2604`，`data/source_rent.csv`）

`update_rent_values()` 以 `times_rent_paid` 为索引 `match`，设定**下一次**应付租金。

| 第 n 次付租 | 金额 | 楼层门槛附加 |
|---|---|---|
| 1 | **25**（初始值） | — |
| 2 | 50 | — |
| 3 | 100 | — |
| 4 | 150 | — |
| 5 | 225 | — |
| 6 | 300 | — |
| 7 | 350 | `current_floor >= 2` 时 +25 |
| 8 | 425 | `>= 3` 时 +25 |
| 9 | 575 | `>= 18` 时 +25 |
| 10 | 625 | `>= 6` 时 +25 |
| 11 | 675 | `>= 8` 时 +25 |
| 12 | **777** | — |

合计 **4,277 coins**。注意第 9 期的门槛是 `>= 18`（而非按序递增的 4），与 6/8/9/10 期的门槛不成单调序列 —— 代码原样如此，属设计残留而非笔误（置信度 A，语义 A−）。

### 7.2 spins 是**增量**，且累计不重置（A，`Pop-up.gd:2886`）

```text
剩余旋转数 ← 剩余旋转数 + 5 + ⌊n / 2⌋      （n = 本次是第几次付租）
```

`times_rent_paid` 在付租时已自增，故第 n 次付租后获得 `5 + n//2` 次旋转，**追加**到剩余次数上：

| 付租次数 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 本��新增 | 5 | 6 | 6 | 7 | 7 | 8 | 8 | 9 | 9 | 10 | 10 | 0 |
| 累计 | 10 | 16 | 22 | 29 | 36 | 44 | 52 | 61 | 70 | 80 | **90** | 90 |

**全程可用 90 次旋转。**

这一条同时解决了 v3.0 的一处语义模糊：wiki 的 spins 序列 `5,5,6,6,7,7,8,8,9,9,10,10` 不是"每期可用次数"，而是**每期增量**（wiki 首个 5 对应初始值，与公式逐项吻合）。

### 7.3 难度骨架的定量结果

\[
\frac{4277\ \text{coins}}{90\ \text{spins}} \approx 47.5\ \text{coins/spin}
\]

即玩家必须让**平均每次旋转产出 47.5 金币**才能通关，且因为租金递增，后期的瞬时需求远高于此（第 12 期需 777/10 ≈ 77.7 coins/spin）。这是本作难度曲线的硬约束，也是评估"某流派是否可行"的基准线。

### 7.4 无尽模式（A，`Pop-up.gd:2583`）

```
第 1~12 期：固定表（见 7.1）
第 n > 12 期：rent = 500 + (n - 12) * 500，spins 固定 +10
```

即无尽期租金线性 +500，旋转供给不再增长（每期 10 次），需求线性上升、供给恒定 → 必然收敛于死亡，符合"无尽即耗尽"的设计。

### 7.5 精华代币不结转（A，`Pop-up.gd:2873-2877`）

```text
queued_essence_emails ← essence_tokens      （未用代币转入邮件队列）
essence_tokens        ← 0                   （立即清零）
```

**付租瞬间精华代币清零**，未使用的代币被转成邮件（等价于作废/延后）。因此"攒代币到后期再用"是无效策略。

> 待复核：邮件（26 条）是否提供代币返还，未穷举。

### 7.6 金币是否结转

`coins` 是 `Main` 上的单一变量（`Main__Main.gd:1277`），付租通过 `Coin Sum.add_value(-rent)` 递减同一变量，**不存在"每期重置"逻辑** → 余额结转（A−）。

---

## 8. 难度缩放

### 8.1 `dud` 注入（A，`Reels.gd:273-281`）

每次旋转按当前难度向池中注入无价值符号 `dud`，随旋转次数/楼层提高频率（每 15 / 20 / 25 spins 一档）。这是"池子稀释"型难度：不改变已有符号的价值，而是降低有效格占比。

与 §3.2 结合可得：**难度直接作用于洗牌命中率**，等价于把 \\(P=20/S\\) 中的分子缩小。

### 8.2 `comrade_values` 楼层分档（A，`Pop-up.gd` 附近）

| 楼层 | 取值 |
|---|---|
| ≥ 16 | `[1, 1, 1]` |
| ≥ 9 | `[1, 1, 2]` |
| ≥ 4 | `[2, 1, 2]` |
| 其他 | `[2, 2, 2]` |

控制"同伴类"符号（`doglikes` / `beelikes` 等）的生成数量。

### 8.3 37 条 Fine Print（A，`data/fine_print.csv`）

每条含 `difficulty` / `reliant_types` / `reliant_groups` / `values`，是**全局规则修正**（如 `num == 22` 会移除斜向邻接，见 `Slot_Icon.gd:1177-1188`）。它们是按楼层逐步生效的"规则变异"，而非数值加成。

---

## 9. 对既有结论的修订

| v3.0 表述 | 源码事实 | 处置 |
|---|---|---|
| §3.1 "每 spin 独立、均匀、有放回抽取" | 旋转只是 `shuffle()` 重排既有池，20/`S` 命中 | **作废**，改写为 §3.2 |
| §3.1 表 "无放回放置（超几何）" | 也不是放置：池由玩家资产决定，洗牌不改变集合 | **作废** |
| §A.4 "6/9/10 期保底 U+ / 1×R+ / 2×R+"（B 级） | 源码**不存在**任何保底逻辑 | **证伪**，从 CSV 删除 `guarantee` 列 |
| §6 推论 3 "冻结 + 保底补偿" | 前提消失 | 改写为"冻结 + spins 增量供给" |
| spins 序列 "5,5,6,6,…" 语义不明 | 是**增量**，`5 + n//2`，累计 90 | **A 级确认并明确语义** |
| 稀有度 68/30/1.5/0.5 | 逐字吻合（第 5 期冻结） | **B → A** |
| 道具稀有度与符号同档 | 道具是 56/37.5/5/1.5，第 6 期冻结 | **修正** |
| 邻接 = 上下左右 | **8 邻域（含对角）**，`Slot_Icon.gd:1182-1188` | **修正** |
| 附录 F.6 "拿不到规则逻辑" | 已通过内嵌脚本完整取得 26,583 行 | **作废** |

---

## 10. 可复现性与材料边界

### 10.1 仓库内有什么、没有什么

| 类别 | 是否入库 | 说明 |
|---|---|---|
| 机制与算法文档（`docs/`） | ✅ | 结论、公式、伪代码、数据表 |
| 数值结论表（`data/*.csv`） | ✅ | 租金、概率、符号/道具/精华/细则属性值 |
| 原始作品（`.apk`） | ❌ | 属商业软件，不入库 |
| 反编译产物（解包后的 dex / java / 资源） | ❌ | 仅作者本地保存 |
| 提取出的游戏源码（`.gd`） | ❌ | 仅作者本地保存 |
| 反编译 / 静态分析脚本（`analysis/`） | ❌ | 研究过程，仅本地 |
| 代码结构派生物（函数索引、分支行号） | ❌ | 可本地重生成 |
| 原始资源 JSON（`analysis/data/raw/`） | ❌ | 原作者资产，仅本地研究目录 |
| 邮件正文（`analysis/data/emails.csv`） | ❌ | 原作叙事文本，含版权内容，仅本地研究目录 |
| 发布检查脚本（`analysis/preflight.ts`、`analysis/rent-model.ts`） | ✅ | 只断言数值与数据链路，不含原作内容 |

上述排除项均写入 `.gitignore`。`analysis/data/` 整体被忽略，只存在于作者本地；`data/` 下只保留 9 张由数值结论构成的表，构建与校验都只消费这些表。`analysis/preflight.ts` 会断言 `data/raw`、`data/emails.csv` 不会出现在 `data/` 或 `web/`，并确认构建脚本没有指向本地研究目录。

### 10.2 读者如何复核本文结论

除了按下表手算，`web/` 提供了一个可运行的静态复现台：24 条断言直接核对 `data/*.csv`，洗牌/抽取、稀有度、租金路径、8 邻域四组实验可现场跑出数字（`npm --prefix web run dev`，构建产物可托管在 GitHub Pages）。本文的每一条数值结论都可**脱离源码**独立复算：

| 结论 | 复核方式 |
|---|---|
| 12 期租金合计 4,277 | `data/source_rent.csv` 求和 |
| spins 累计 90 = 5 + Σ(5+⌊n/2⌋) | 同上，按第 7.2 节公式手算 |
| 第 12 期需 47.5 / 77.7 coins per spin | 4,277/90、777/10 |
| 稀有度两套档位 | `data/source_rarity.csv`，各行四档求和 = 1 |
| 符号/道具/精华属性 | `data/symbols.csv` 等，与游戏内面板逐条比对 |

需要源码级核对时，请通过合法途径取得游戏本体，按附录 A 的函数名定位；本文不提供、也不链接任何反编译资源。

### 10.3 数据表清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `data/source_rent.csv` | 数值结论 | 12 期租金、楼层门槛、spins 增量与累计 |
| `data/source_rarity.csv` | 数值结论 | 符号/道具两套四档概率（逐期） |
| `data/symbols.csv` | 数值结论 | 168 符号的属性值 |
| `data/items.csv` / `essences.csv` | 数值结论 | 114 道具 / 113 精华 |
| `data/fine_print.csv` | 数值结论 | 37 条细则的触发条件与参数 |
| ~~26 封邮件~~ | 不入库 | 邮件正文与选项为原作叙事文本，含版权内容，仅本地留存；本文只引用"共 26 条"这一计数事实 |
| `data/rent.csv` / `offer_rarity.csv` | 早期推导 | v3.0 由 wiki 反推，**已被 `source_*` 取代**；保留用于对比 |

---

## 附录 A：核心函数索引

> 行号可能因版本差异而偏移，核对时建议按**函数名**定位；数值结论可直接用 §10.2 的表格复算。

| 文件:行 | 函数 | 作用 |
|---|---|---|
| `Pop-up.gd:2559-2604` | `update_rent_values` | 租金 / 稀有度 / 无尽 |
| `Pop-up.gd:1123-1270` | `add_cards` | 单格抽取 |
| `Pop-up.gd:2831-2920` | `rent_due` | 付租、spins 增加、代币清零 |
| `Main.gd:1277-1310` | `_ready` / `new_game` | 初始状态 |
| `Reels.gd:183-306` | `spin` | 一次旋转 |
| `Reels.gd:368-429` | `shuffle_tiles` | 洗牌重排 |
| `Reels.gd:906-1102` | `check_effects` | 效果不动点迭代 |
| `Reels.gd:1103-1578` | `check_values` | 取值汇总 |
| `Reels.gd:1738-2044` | `finalize_clumps` | 折叠永久值、收尾 |
| `Slot_Icon.gd:1080-1145` | `get_value` | **核心数值公式** |
| `Slot_Icon.gd:1146-1200` | `get_adjacent_icons` | 8 邻域 |
| `Slot_Icon.gd:939-957` | `add_permanent_bonus` | 永久加成 |
| `Slot_Icon.gd:3652-4720` | `add_conditional_effects` | 符号效果声明 |
| `Slot_Icon.gd:1742-2529` | `do_diff` | 效果解释器 |

## 附录 B：尚未覆盖（待复核）

| 项 | 状态 |
|---|---|
| `check_values` 的完整入账路径（`coins` 增加点） | 未逐行追踪 |
| 邮件系统的实质效用（26 条） | 未解析 |
| 成就 / 无尽排行 | 未解析 |
| `do_diff` 中 `reverse_eff` 的回滚边界 | 未穷举 |
| 37 条 fine_print 的逐条语义 | 仅抽样（#22） |
