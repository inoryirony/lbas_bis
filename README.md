# 陆航优化

Poi 基地航空队配装、制空与连续波次模拟插件。

插件可以读取 Poi 当前装备仓库，也可以加入未持有的理论装备。未持有装备会保留在候选方案中并明确标记，不会被当成真实库存。

## 功能

- 支持 1-3 个基地航空队，每队 0-4 架飞机及显式空槽。
- 装备槽和空槽都可以锁定；锁定实例会在全局搜索开始前预留。
- 按 API 装备类型计算一般飞机 18、陆侦 4、大型陆攻 9 的基地搭载数。
- 计算出击制空、拦截、改修、内部/可见熟练度区间、陆侦系数和基地航程。
- 显示“统一最低可见熟练度”。这是整队使用同一个可见熟练等级的门槛，不是逐架熟练度优化。
- 提供静态敌制空估算和详细敌机槽逐波模拟两种模式。
- 使用分组 branch-and-bound 搜索，并显示搜索状态、探索节点和是否已经证明最优。
- 小规模随机场景会与独立穷举 oracle 对拍，防止剪枝删除可行解或最优解。

## 两种计算模式

### 静态估算

只输入敌方总制空。每一波都使用相同敌制空值，因此结果会标记为“静态估算”，不会声称已经模拟上一波造成的敌机损失。

静态目标是硬约束。搜索完成且 `provenOptimal` 为 true 时，结果才是当前库存、锁定、航程和目标状态下已证明的 Top K；若预算耗尽，已有结果只表示当前找到的最好方案。

### 详细逐波模拟

输入敌方每个航空槽的有效出击对空、当前搭载和最大搭载。模拟按实际顺序更新敌方槽位：

1. 计算当前双方制空并判定制空状态；
2. 结算该波敌方 Stage 1 损失；
3. 集中派遣的第二波按削减后的敌制空继续计算；
4. 集中派遣只在第二波按第二波状态结算一次我方普通 Stage 1 损失；
5. 喷式强袭作为独立阶段计算，空袭格不会触发。

Monte Carlo 使用可复现的 64 位坐标随机数。相同 seed 和采样数会得到相同结果，方案遍历顺序不会改变评分。

详细模式当前只模拟单个敌方节点的集中派遣。底层计算支持向两个独立敌舰队分散派遣，但敌方损失不会从第一个节点带到第二个节点。

## 搜索状态

- `optimal`：搜索已完成，`provenOptimal: true`。
- `infeasible`：完整搜索后确认无解。
- `budget_exhausted`：搜索或模拟预算耗尽，不能宣称无解或全局最优。
- `invalid_input`：锁定实例、详细敌槽、采样数等输入无效。

`maxResults` 只限制返回的 Top K 数量，不会作为“找到若干方案就停止”的搜索截断。

## 已知限制

- 敌方只有总制空时无法连续削减敌机，必须使用静态估算。
- 详细模式尚未模拟敌舰队防空 Stage 2、我方普通 Stage 2 和喷式强袭 Stage 2；我方剩余搭载、资源损失和伤害代理可能偏乐观。
- 伤害值是普通水上目标的攻击力代理，不包含敌装甲、舰种/活动特效、接触、暴击、熟练暴击和最终扣血。
- 暂无地图/节点预设，也不计算舰娘日战或夜战伤害。

## 使用

1. 在 Poi 插件列表启用 `陆航优化`。
2. 设置目标半径、基地队数和每波目标状态。
3. 选择 `静态估算` 输入总敌制空，或选择 `详细逐波模拟` 编辑敌机槽。
4. 选择装备；需要固定的装备或空槽勾选 `锁定`。
5. 选择 `仅持有装备` 或 `包含未持有理论装备`。
6. 点击 `计算优化`，查看证明状态后可将方案导入模拟器。

## 本地安装到 Poi

Windows 开发环境建议让 Poi 插件目录直接 Junction 到仓库，这样每次拉取或修改后无需重复复制：

```powershell
$source = 'E:\path\to\lbas_bis'
$target = "$env:APPDATA\poi\plugins\node_modules\poi-plugin-lbas-bis"
New-Item -ItemType Junction -Path $target -Target $source
```

本机实际目标目录应为：

```text
C:\Users\<user>\AppData\Roaming\poi\plugins\node_modules\poi-plugin-lbas-bis
```

Poi 运行中不会自动重载插件，更新后需要重启 Poi。

## 开发与验证

```bash
npm install
npm test
npm run typecheck
npm pack --dry-run
```

主要模块：

- `src/aircraft.js`：API 装备类型与独立能力标记。
- `src/air-power.js`：搭载、制空、熟练度、陆侦和航程公式。
- `src/optimizer.js`：分组 branch-and-bound、预算与搜索状态。
- `src/exhaustive-optimizer.js`：小规模独立穷举 oracle。
- `src/wave-simulator.js`：Stage 1、喷式强袭和连续波次 Monte Carlo。
- `src/simulator-state.js`：Poi UI 的静态/详细输入状态。

公式回归参考 [noro6/kc-web](https://github.com/noro6/kc-web) 的 `item.ts`、`airbase.ts`、`commonCalc.ts` 和 `calculator.ts`。交互与结果也可对照 [kc-web aircalc](https://noro6.github.io/kc-web/#/aircalc)；战斗记录结构可参考 [KC3Kai/kancolle-replay](https://github.com/KC3Kai/kancolle-replay)。
