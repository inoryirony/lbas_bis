# 陆航优化

Poi 插件：基地航空队制空与配装优化器。

当前版本是手动输入目标的 MVP，不做地图预设。插件会读取 Poi 当前持有装备，按目标半径、敌制空、基地队数和每波目标状态，搜索不重复使用同一装备实例的 4 格陆航配装。

## 当前能力

- 内嵌在 Poi 插件页，不新开独立页面。
- 插件标题与默认界面为中文，支持 `zh-CN`、`zh-TW`、`en-US`、`ja-JP` 多语言。
- 支持 1-3 个基地航空队；每个 base 按 2 波计算，所以最多显示 6 波目标状态。
- 满足制空目标后，优先尽可能多放陆攻，再按陆攻伤害基准排序。
- 计算出击制空、陆战拦截值、改修加成、熟练度可见加成、陆侦制空系数、侦察机/大艇延程和制空状态。
- 计算陆攻对普通水上目标的伤害基准；该值是未扣敌装甲的攻击力估算。

## 使用方式

1. 在 Poi 插件列表启用 `陆航优化`。
2. 输入目标半径、敌制空和基地队数。
3. 为每一波选择目标状态：劣势、均势、优势、确保。
4. 点击 `计算配装`。

结果会显示每个方案的总伤害基准、最小制空余量、6 波状态，以及每队使用的装备。

## 暂不包含

- 不包含地图/节点预设。
- 不模拟每波陆航削弱敌机后的连续敌制空变化；当前每波按同一个敌制空值验算。
- 不计算蓝字、倍卡、舰娘日战/夜战伤害。
- 陆攻伤害暂不输入敌舰装甲、目标类型、接触、暴击、熟练暴击等条件，因此不是最终扣血值。

## 本地安装到 Poi

本机开发时可以将仓库作为 file 依赖装入 Poi 插件目录：

```bash
cd "$HOME/Library/Application Support/poi/plugins"
npm install /Users/tianzema/Documents/kancolle/lbas_bis --save --no-prune
```

安装后应出现：

```text
node_modules/poi-plugin-lbas-bis -> /Users/tianzema/Documents/kancolle/lbas_bis
```

Poi 需要重启后重新扫描插件。

## 开发

```bash
npm install
npm test
npm run typecheck
npm pack --dry-run
```

核心文件：

- `index.js`：Poi 插件入口和界面。
- `src/poi-data.js`：Poi 装备数据适配和装备类型识别。
- `src/air-power.js`：制空、熟练度、陆侦、延程和制空状态计算。
- `src/damage.js`：陆攻伤害基准估算。
- `src/optimizer.js`：候选池、组合搜索、6 波验算和排序。
