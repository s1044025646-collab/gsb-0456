# Floyd–Steinberg 二值化与误差传播核验后端

这是一个只包含后端 API 与 CLI 的本地 TypeScript/Node.js 项目。它接收 0..255 的 JSON 整数灰度矩阵，使用 Floyd–Steinberg 误差扩散生成同尺寸的 0/255 矩阵，并保存每个像素的误差来源、工作值、输出和实际传播去向。

不包含图片编辑界面、调色板学习、分辨率调整、桌面窗口、Docker、WSL 或在线服务。持久化使用 Node.js 内置 `node:sqlite`，数据库默认位于项目内 `data/floyd.sqlite`。

## 环境

- Windows PowerShell
- Node.js 25（已在此版本验证；需要内置 `node:sqlite`）
- npm

`node:sqlite` 当前需要 `--experimental-sqlite` 参数。项目脚本已经配置。

## 构建、测试、启动和演示

```powershell
npm install
npm run build
npm test
npm start
npm run demo
```

默认不设置 `PORT` 时，服务自动选择 `127.0.0.1` 的空闲端口并在终端打印。也可以指定：

```powershell
$env:PORT="3000"
$env:DATA_DIR="E:\GSB\0456\B\data"
npm start
```

## 算法约定

规则版本固定为 `floyd-steinberg-v1`。

### 普通从左向右扫描

按行从上到下，每行从左到右。当前像素：

```text
工作值 = 原灰度 + 此前收到的误差
输出   = 工作值 >= 128 ? 255 : 0
误差   = 工作值 - 输出
```

误差权重：

| 接收者 | 权重 |
| --- | --- |
| 右 | 7/16 |
| 左下 | 3/16 |
| 正下 | 5/16 |
| 右下 | 1/16 |

### 蛇形扫描

行号从 0 开始。偶数行从左向右，奇数行从右向左。右向左时水平方向镜像：

| 接收者 | 权重 |
| --- | --- |
| 左 | 7/16 |
| 右下 | 3/16 |
| 正下 | 5/16 |
| 左下 | 1/16 |

误差只写入本次扫描顺序中尚未处理的格，绝不反向修改已经输出的像素。原图矩阵始终不被修改。

### 阈值、边界和数值

- 阈值比较为“工作值大于或等于 128 输出 255”，否则输出 0。
- 工作值允许临时小于 0 或大于 255，不提前裁剪，不逐次取整。
- 越界邻格的份额直接丢弃，不重新归一化给剩余邻格，不跨行绕回第一列。
- 丢弃误差使用有符号份额累计。账目核验为：

```text
原灰度总和 - 输出总和 ≈ 边界丢弃误差总和
```

不能把误差绝对值之和代入该账目。公开容差为：

```text
max(1e-9, 像素数 × 256 × Number.EPSILON)
```

二值化通常不保证平均亮度完全守恒；边界丢失正负误差、量化离散化和浮点舍入都会影响平均值。

### 已知用例

```text
输入 [128, 128]，普通扫描
输出 [255, 0]
第一像素误差 -127
第二像素工作值 128 + (-127 × 7/16) = 72.4375
有符号边界丢弃误差合计 1
```

## 输入限制与错误

只接受矩形、非空二维整数矩阵：

- 宽、高最大均为 512。
- 元素总数最大为 20000。
- 元素必须是整数且位于 0..255。
- 拒绝空矩阵、空行、长短行、小数、范围外数值和未知扫描模式。

错误响应统一为：

```json
{
  "error": {
    "code": "PIXEL_OUT_OF_RANGE",
    "message": "坐标 (0,1) 的值 256 超出 0..255"
  }
}
```

常见错误码：`EMPTY_MATRIX`、`EMPTY_ROW`、`RAGGED_MATRIX`、`INVALID_PIXEL_TYPE`、`PIXEL_OUT_OF_RANGE`、`MATRIX_TOO_LARGE`、`INVALID_MODE`、`INVALID_BOUNDARY_POLICY`、`INVALID_COORDINATE`、`NOT_FOUND`。

校验失败时不会创建报告或留下“半张成功图”。计算结果在全部像素处理完成后一次性作为完整 JSON 写入 SQLite。

## 持久化与幂等

- 数据集和报告使用相互独立的内容 SHA-256 ID。
- 相同输入重复导入返回同一数据集 ID。
- 相同数据集、模式、边界策略、规则版本和展示预算返回原报告。
- 改变扫描模式会创建新报告，不覆盖、不重算旧报告。
- 重启后可读取全部正式结果及当时配置。
- 多次读取、像素查询和传播查询不会改变算法状态。

## HTTP API

以下示例假设服务地址为 `http://127.0.0.1:3000`。

### 健康检查

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

### 导入矩阵

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3000/datasets `
  -ContentType "application/json" `
  -Body '{"matrix":[[128,128],[10,240]]}'
```

### 创建或读取报告

`mode` 为 `lr` 或 `serpentine`。`traceBudget` 可选。

```powershell
Invoke-RestMethod -Method Post `
  http://127.0.0.1:3000/datasets/<datasetId>/reports `
  -ContentType "application/json" `
  -Body '{"mode":"lr","boundaryPolicy":"discard","traceBudget":10}'
```

新计算返回 HTTP 201，重复请求返回 HTTP 200。

### 查询单个像素

```text
GET /reports/<reportId>/pixels?row=1&col=2
```

返回：原值、收到误差、工作值、输出、待分配像素误差，以及每个实际接收坐标、权重和份额。若像素坐标位于正式输出内但详细记录被预算截断，返回明确的 `NOT_FOUND` 解释；正式 `output` 仍完整可读。

### 查看有限传播步骤

```text
GET /reports/<reportId>/trace?limit=10
```

报告中有：

- `calculationComplete`：正式计算是否完整，始终独立标记。
- `traceComplete`：当前详细传播解释是否完整。
- `traceTruncated`：解释是否截断。
- `truncationReason`：截断说明。

展示预算只影响保存/展示的详细记录数量，不跳过像素、不改变正式输出。

### 比较模式

```powershell
Invoke-RestMethod -Method Post `
  http://127.0.0.1:3000/datasets/<datasetId>/compare `
  -ContentType "application/json" `
  -Body '{"firstMode":"lr","secondMode":"serpentine"}'
```

也可以比较任意两个已有报告：

```text
POST /reports/compare
{"firstReportId":"...","secondReportId":"..."}
```

### 报告、冻结重算核验、导出

```text
GET /reports/<reportId>
GET /reports/<reportId>?verify=true
GET /reports/<reportId>/export?format=json
GET /reports/<reportId>/export?format=pgm-ascii
GET /reports/<reportId>/export?format=pgm
```

`pgm` 是二进制 `P5` PGM，`pgm-ascii` 是纯文本 `P2` PGM。它们只编码最终黑白矩阵，可供本地图像查看器或其他工具打开；服务本身不依赖桌面窗口。

## CLI

CLI 与 API 使用同一个 SQLite 数据目录。

```powershell
node --experimental-sqlite dist/cli.js demo
node --experimental-sqlite dist/cli.js import sample.json
node --experimental-sqlite dist/cli.js run <datasetId> --mode lr
node --experimental-sqlite dist/cli.js run <datasetId> --mode serpentine --trace-budget 8
node --experimental-sqlite dist/cli.js pixel <reportId> 1 2
node --experimental-sqlite dist/cli.js trace <reportId> --limit 10
node --experimental-sqlite dist/cli.js compare <datasetId>
node --experimental-sqlite dist/cli.js compare --reports "<reportIdA> <reportIdB>"
node --experimental-sqlite dist/cli.js export <reportId> --format pgm --out result.pgm
node --experimental-sqlite dist/cli.js export <reportId> --format pgm-ascii
```

小样例演示使用 `█` 表示 255、`·` 表示 0，同时打印数值矩阵和均值，并比较固定阈值、普通扩散和蛇形扩散。

## 项目结构

```text
src/dither.ts      Floyd–Steinberg 核心计算和固定阈值参考
src/store.ts       SQLite 数据集/报告持久化与幂等 ID
src/server.ts      HTTP API 和空闲端口选择
src/cli.ts         CLI、字符图和演示
src/service.ts     像素查询、传播预算、比较和重算核验
src/validation.ts  尺寸、元素和参数校验
src/pgm.ts         P5/P2 PGM 导出
src/dither.test.ts 独立二维参考传播及持久化测试
```

## 验证范围

测试包含：

- 已知 `[128,128]` 用例。
- 单像素、单行、单列、0、255、阈值恰为 128。
- 蛇形奇数行从右向左和权重镜像。
- 工作值临时越界且不裁剪。
- 随机小矩阵与独立二维参考传播实现逐像素核对。
- 有符号边界误差账目，不使用绝对值之和。
- 只向未处理像素传播，已处理像素不被修改。
- 非法输入拒绝。
- 展示预算不改变正式输出。
- SQLite 幂等、模式报告并存及重启读取。

## 当前限制

- 仅支持 `discard` 边界策略。
- 最大矩阵为 512×512，且总像素数不超过 20000。
- 使用 Node.js 内置实验性 SQLite API；未来 Node 主版本可能调整该 API。
- 完整传播记录与结果以 JSON 保存，适合核验和中小矩阵，不以超大图像批处理为目标。
