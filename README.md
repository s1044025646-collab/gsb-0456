# Floyd–Steinberg 二值化与误差传播核验后端

本地灰度矩阵误差扩散服务：输入 `0..255` 的整数像素矩阵，按 Floyd–Steinberg 算法
把它抖动成只含 `0` 和 `255` 的同尺寸矩阵，并提供逐像素的误差来源/去向、传播步骤、
边界误差账目核验与 PGM 导出。**只做 API 与 CLI，无图像编辑界面、无调色板学习、
无分辨率调整、无任何在线服务。**

- 语言/运行时：TypeScript + Node.js（要求 Node `>=22.5`，开发于 Node 25）。
- 存储：Node 内置 `node:sqlite`（`DatabaseSync`），零原生第三方依赖、无需编译工具链。
- 运行：纯本地 `127.0.0.1`，不依赖 Docker / WSL / 付费或在线 API。

## 算法约定（务必先读）

规则版本固定随结果保存为 `floyd-steininberg-1.0`。

1. **扫描顺序**
   - 普通模式 `lr`：每行从左向右、从上向下。
   - 蛇形模式 `serpentine`：偶数行（行号从 0 起）从左向右，奇数行从右向左。
2. **逐像素处理**（严格按扫描顺序，不能先全图量化再摊误差，也不能回写原图）：
   - 收到误差 `receivedError`：此前已处理像素传播到本格的误差累计。
   - 工作值 `workingValue = original + receivedError`，**允许暂时越过 0..255，不提前裁剪、不逐次取整**。
   - 输出 `output = workingValue >= 128 ? 255 : 0`（阈值恰等于 128 输出白 255）。
   - 本像素待分配误差 `carryError = workingValue - output`。
3. **误差权重（Floyd–Steinberg）**
   - 左→右行：右 `7/16`、左下 `3/16`、下 `5/16`、右下 `1/16`。
   - 右→左行（蛇形奇数行）：水平方向镜像，即 左 `7/16`、右下 `3/16`、下 `5/16`、左下 `1/16`。
   - 只发给本次扫描顺序中**尚未处理**的像素；永不反向修改已输出像素。
4. **边界策略（仅支持 `discard`）**：越界份额直接丢弃，**不重新归一到剩余邻格，也不跨行绕回**。
5. **数值精度与守恒账目**
   - 全程使用 IEEE-754 双精度浮点（`Float64Array` / `number`），权重即 `7/16` 等二进制浮点，
     逐次累加，不做整数化。
   - 边界丢弃按**有符号数**累加为 `discardedSum`（不是各份额绝对值之和）。
   - 公开容差：每像素 `1e-9`（`CONSERVATION_TOLERANCE_PER_CELL`），
     核验 `|原灰度总和 − 输出总和 − discardedSum| ≤ 像素数 × 1e-9`。
   - 结果中的 `conservationVerified` 即该账目是否在容差内。
   - **不宣称平均亮度一定完全守恒**：输出只有 0/255，且边界份额被丢弃，平均灰度可能变化。

已知样例（普通模式，一行 `[128,128]`）：

- 第 1 个像素工作值 128 → 输出 255，待分配误差 `-127`。
- 右邻收到 `-127 × 7/16 = -55.5625`，第二像素工作值 `128 − 55.5625 = 72.4375` → 输出 0。
- 越界份额有符号合计为 `1`，输出 `[255,0]`。

## 输入校验与错误码

仅接受**非空矩形整数矩阵**：不接受空矩阵、空行、长短行（非矩形）、
小数、非数值、超出 `0..255` 的值，以及非法模式/边界。失败时不写入任何数据，
不会留下“半张成功图”。

尺寸限制（可在 `DEFAULT_LIMITS` 调整）：宽 ≤ 4096、高 ≤ 4096、总像素 ≤ 262144，
防止错误宽高导致无界内存分配。

统一错误响应：`{ "error": { "code": "...", "message": "..." } }`。

| code | 含义 |
| --- | --- |
| `EMPTY_MATRIX` / `EMPTY_ROW` | 空矩阵 / 空行 |
| `NOT_RECTANGULAR` | 各行长度不一致 |
| `INVALID_VALUE` | 元素非 0..255 整数（含小数、非数值、越界） |
| `INVALID_DIMENSIONS` | 宽/高/总像素超限 |
| `INVALID_MODE` / `INVALID_BOUNDARY` | 扫描模式 / 边界策略非法 |
| `INVALID_PARAM` / `BAD_JSON` / `BODY_TOO_LARGE` | 参数非法 / JSON 非法 / 请求体过大（16MB） |
| `NOT_FOUND` / `CONFLICT` / `INTERNAL` | 资源不存在 / 冲突 / 内部错误 |

## 数据与持久化

- 数据目录默认为项目内 `./data`，可用环境变量 `FS_DITHER_DATA_DIR` 覆盖；SQLite 文件为 `dither.db`。
- **数据集**与**报告**使用独立 ID（`ds_…`、`rp_…`）。
- 数据集按矩阵内容 SHA-256 去重：重复导入返回原 ID；重复读取不改变算法状态。
- 报告按 `(数据集, 模式, 边界, 规则版本)` 幂等：改变模式生成**新报告**，旧结果不重算、不覆盖。
- SQLite 保存原始矩阵、尺寸、规则版本与完整输出/逐像素记录/汇总；**重启后仍可读取全部正式结果及当时配置**，
  并可用 `verify` 从冻结原图重算核对。

## 构建、测试、启动、演示

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # 编译测试并运行 node --test（15 个测试）
npm start         # 启动 HTTP API（默认端口 0 = 系统选空闲端口，启动后打印实际端口）
npm run demo      # CLI 内置样例：已知样例 + 常量/渐变/棋盘 三种模式对比
```

指定端口与数据目录：

```powershell
node dist/src/cli/cli.js serve --port=8080
$env:FS_DITHER_DATA_DIR="$PWD\data"; node dist/src/cli/cli.js serve
```

## CLI

```text
serve [--port=0]
import <矩阵JSON | @file.json | ->               # - 表示从 stdin 读 JSON
run <datasetId> [--mode=lr|serpentine] [--boundary=discard]
report <reportId> [--budget=N]                   # 数值矩阵 + 字符图 + 均值/误差汇总
pixel <reportId> <row> <col>                     # 单像素原值/收到误差/工作值/输出/待分配/各接收坐标
steps <reportId> [--budget=N]                    # 按扫描顺序查看传播步骤
compare <datasetId>                              # 固定阈值 vs 普通扩散 vs 蛇形
export <reportId> <out.pgm|out.json> [--layer=output|json|original]
demo
```

字符图使用 `█`（白 255）与 `·`（黑 0），不依赖桌面图像窗口。

CLI 最小流程：

```powershell
node dist/src/cli/cli.js import '[[128,128],[0,255]]'
node dist/src/cli/cli.js run ds_xxxx --mode=serpentine
node dist/src/cli/cli.js report rp_yyyy
node dist/src/cli/cli.js pixel rp_yyyy 0 1
node dist/src/cli/cli.js export rp_yyyy out.pgm
```

## HTTP API

仅监听 `127.0.0.1`，请求/响应均为 JSON（导出接口除外）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/datasets` | 导入矩阵（body 即二维数组；重复返回原 ID） |
| GET | `/datasets` | 数据集列表（元信息） |
| GET | `/datasets/{id}` | 取数据集原始矩阵 |
| POST | `/datasets/{id}/reports` | 执行扩散，body：`{"mode":"lr","boundary":"discard"}` |
| GET | `/datasets/{id}/compare` | 固定阈值 / 普通 / 蛇形三者对比（不落库） |
| GET | `/reports` | 报告列表 |
| GET | `/reports/{id}?budget=N` | 完整报告（budget 仅截断逐像素展示） |
| GET | `/reports/{id}/steps?budget=N` | 有限传播步骤 |
| GET | `/reports/{id}/pixels/{row},{col}` | 单像素来源与分配明细 |
| GET | `/reports/{id}/export?layer=output\|json\|original` | 导出 PGM / 输出 JSON / 原矩阵 JSON |
| POST | `/reports/{id}/verify` | 从冻结原图重算并核对已保存报告 |

`budget`（展示预算）达到时只截断返回的逐像素详细记录，响应中 `truncation.explanation`
会用中文说明截断了多少条；**不会少处理任何像素，也不影响正式输出/汇总**，
`officialComputationComplete` 恒为 `true`。

```powershell
$b = 'http://127.0.0.1:8080'
Invoke-RestMethod "$b/datasets" -Method Post -ContentType 'application/json' -Body '[[128,128],[0,255]]'
Invoke-RestMethod "$b/datasets/ds_xxx/reports" -Method Post -ContentType 'application/json' -Body '{"mode":"serpentine"}'
Invoke-RestMethod "$b/reports/rp_xxx?budget=10"
Invoke-RestMethod "$b/reports/rp_xxx/pixels/0,1"
Invoke-WebRequest "$b/reports/rp_xxx/export?layer=output" -OutFile out.pgm
```

## PGM 导出

导出为二进制 `P5`、8 位灰度、最大值 255，像素值只有 `0`/`255`，
任何支持 PGM 的查看器或后续工具均可打开；后端本身不需要图像窗口。

## 测试

- 单像素、单行、单列、0/满灰、阈值恰为 128、蛇形奇数行方向、工作值越界（负值）。
- 权重账目：有符号丢弃误差满足守恒容差；误差只流向未处理像素、不回写已输出像素。
- **独立的二维参考传播实现**（测试内用独立的 `number[][]` 缓冲与权重表）
  对 60 组随机小矩阵×两种扫描，逐像素核对输出与丢弃量完全一致。
- 服务层：导入幂等、模式产生独立报告、预算只截断展示、重开数据库（模拟重启）后
  从冻结原图重算一致、PGM 仅含 0/255。

## 范围与限制

- 仅处理 JSON 数值矩阵；不读取 PNG/JPEG 等图像文件，也不提供编辑 GUI。
- 边界策略只实现 `discard`；输入尺寸受 `DEFAULT_LIMITS` 约束。
- `node:sqlite` 在当前 Node 版本会打印一条 ExperimentalWarning，不影响功能。
- 不保证平均亮度守恒，只保证误差账目在公开浮点容差内成立。
