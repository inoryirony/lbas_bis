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
- 提供海域、节点、难度和敌编成级联选择；最新活动图优先，唯一难度自动选择，选定敌编成后立即应用；仍可更换敌舰或完全自定义敌机槽。
- 小窗口自动改为上下布局，装备名称与属性分行显示；内部装备实例编号不占用界面空间。
- 静态 Rank-1 使用容量支配与精确基地前沿搜索；详细模式和 Top K 使用分组 branch-and-bound，并区分“模型内已证明最优”和“当前固定样本集内已证明最优”。
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

Monte Carlo 使用可复现的 64 位坐标随机数。相同 seed 和采样数会得到相同结果，方案遍历顺序不会改变评分。默认使用 4096 个样本；提高采样数会降低统计误差，但会按比例增加搜索时间。每波和全部波次的达标概率同时给出 Wilson 95% 区间，避免把有限样本点估计误当成精确概率。

详细搜索的 `provenOptimal: true` 只证明结果在当前 seed 对应的固定样本集合上最优，不等于已经证明真实无限样本期望最优。启发式只用于尽快找到当前最好方案，不会删除候选；参与最终证明的剪枝必须是数学安全的上界或硬约束。

代码内还提供敌方 Stage 1 的精确离散 PMF 与受状态预算保护的小规模稀疏推进器，用于公式回归和穷举 oracle。真实活动图的完整敌槽向量单波即可超过数十万状态，因此该推进器不会代替生产 Monte Carlo，也不会通过概率裁剪伪装成精确结果。

详细模式当前只模拟单个敌方节点的集中派遣。底层计算支持向两个独立敌舰队分散派遣，但敌方损失不会从第一个节点带到第二个节点。

## 数据源与自定义

敌舰名称和基础资料来自 Poi 已加载的舰船/装备 master。敌方槽位按以下优先级补全：

1. Poi 官方 master 中存在的槽位和初始装备；
2. noro6 `kc-web` 数据；
3. 已安装的海色相簿 `abyssal.json`。

地图节点编成使用 noro6 公开数据，因为游戏 API 不提供可直接枚举的完整地图编成表。远程数据会缓存到 `%APPDATA%\poi\lbas-bis\noro6-map-data.json`，离线时使用最近缓存。

预设只是填写器，不会锁定输入。数据源尚未更新时可以：

- 选择 `静态估算`，直接输入敌制空总值；
- 选择 `详细逐波模拟`，从各敌舰下拉框更换或清空敌舰；联合舰队会显示完整 12 艘；
- 展开 `自定义敌机槽位`，编辑名称、出击对空、当前搭载、最大搭载，并自由增删槽位。
- 点击 `使用自定义编成`，完整保留静态总制空或详细敌机槽草稿；也可选择 `完全自定义敌舰` 并填写舰名。

## 搜索状态

- `optimal`：搜索已完成，`provenOptimal: true`；静态模式表示模型内严格最优，详细模式表示当前固定样本集内严格最优。
- `infeasible`：完整搜索后确认无解。
- `budget_exhausted`：搜索或模拟预算耗尽，不能宣称无解或全局最优。
- `cancelled`：用户停止后台搜索；若已有可行方案则保留，但标记为未证明最优。
- `invalid_input`：锁定实例、详细敌槽、采样数等输入无效。

`maxResults` 只限制返回的 Top K 数量，不会作为“找到若干方案就停止”的搜索截断。

## 已知限制

- 敌方只有总制空时无法连续削减敌机，必须使用静态估算。
- 地图预设敌舰数据完整时，详细模式会模拟敌舰队对陆航的 Stage 2、装备抗击坠和喷式强袭 Stage 2；敌方对空 CI、我方舰队对敌机的普通 Stage 2 等仍未模拟。
- 伤害值是普通水上目标在逐波搭载损失后的攻击力代理，不包含敌装甲、完整命中率、接触、暴击、熟练暴击和最终扣血；在这些字段补齐前不能据此断言比攻略编成更优。
- 地图编成可能晚于游戏更新；这种情况应使用敌舰下拉和自定义槽位覆盖，不计算舰娘日战或夜战伤害。

## 使用

1. 在 Poi 插件列表启用 `陆航优化`。
2. 可从地图节点预设选择海域、节点、难度和敌编成；预设会自动应用，也可跳过预设完全手动输入。
3. 设置目标半径、基地队数和每波目标状态。
4. 选择 `静态估算` 输入总敌制空，或选择 `详细逐波模拟` 选择敌舰并编辑敌机槽。
5. 选择装备，并可在右侧熟练度下拉框逐架指定模拟熟练度；需要固定的装备或空槽勾选 `锁定`。
6. 优化计算默认按所有飞机熟练度 0（`默认跳海`）；也可选择按每架飞机当前值计算的 `仓库熟练度`，或全部按满熟练计算的 `刷熟练度`。
7. 选择 `仅持有装备` 或 `包含未持有理论装备`；可勾选 `不使用舰载机`，并在 `装备黑名单` 弹窗中排除不参与自动配装的装备。
8. 黑名单预选若干低级飞机，可搜索、清空或恢复默认；手动锁定的装备不受过滤影响。
9. 点击 `计算优化`。首个可行方案会先显示，搜索继续在后台证明最优；可随时停止并保留当前方案。

## CLI 与 AI 调试入口

安装包提供 `lbas-bis` 命令，输入和事件输出均为 JSON，适合脚本、AI 或回归测试调用：

```bash
lbas-bis validate --scenario scenario.json
lbas-bis optimize --scenario scenario.json --jsonl
lbas-bis optimize --scenario scenario.json --poi http://127.0.0.1:17777 --jsonl
lbas-bis optimize --scenario examples/poi-6-5-parity.json --poi http://127.0.0.1:17777 --jsonl
lbas-bis optimize --scenario examples/poi-6-5-map-selection.json --poi http://127.0.0.1:17777 --jsonl
lbas-bis enemy search --name 空母 --poi http://127.0.0.1:17777
```

`--scenario` 的最小结构可参考随包发布的 `examples/cli-static.json`；读取实际库存的 6-5 四波均势可参考 `examples/poi-6-5-parity.json`。不传有限 `nodeBudget` 或 `simulationWorkBudget` 时，CLI 会继续搜索直到证明最优、确认无解或手动终止。

`validate` 和 `optimize` 场景也可以用地图节点直接生成详细敌编成：

```json
{
  "mapSelection": {
    "area": 65,
    "node": "M",
    "difficulty": 0,
    "formationIndex": 0
  }
}
```

`formationIndex` 是所选海域、节点和难度下的零基编成索引。CLI 会通过 noro6 地图数据填充 `enemy`、`enemySlots`、`enemyAir` 和 `targetRadius`，远程不可用时沿用本地缓存。场景中显式提供的 `enemy`、`enemySlots` 或 `enemyAir` 会优先于地图敌编成，显式 `targetRadius` 也不会被覆盖；因此自定义输入可作为地图数据缺失或过期时的离线兜底。

CLI 场景可使用与界面相同的候选过滤，Master ID 黑名单只在显式提供时生效：

```json
{
  "excludeCarrierAircraft": true,
  "blacklistedMasterIds": [16, 19, 20, 21, 23, 25, 221]
}
```

锁定槽中的装备实例始终保留，即使其类型或 Master ID 被过滤。

启用 Poi 本地桥接后，默认地址为 `http://127.0.0.1:17777`：

- `GET /health`：桥接状态；
- `GET /equipment`：当前装备实例；
- `GET /master`：舰船、装备和类型 master。

CLI 的 `--poi` 会通过这三个只读接口读取实际仓库，不需要逐件输入装备。

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
