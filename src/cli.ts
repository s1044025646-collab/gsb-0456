#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exit } from "node:process";
import { fixedThreshold, matrixAverage, runDithering } from "./dither.js";
import { ApiError } from "./errors.js";
import { toAsciiPGM, toBinaryPGM } from "./pgm.js";
import { compareResults, getPixel, traceSteps } from "./service.js";
import { DitherStore } from "./store.js";
import { validateMatrix, validateMode } from "./validation.js";

function usage(): string {
  return `用法:
  fsdither demo
  fsdither import <matrix.json>
  fsdither run <datasetId> --mode lr|serpentine [--trace-budget N]
  fsdither pixel <reportId> <row> <col>
  fsdither trace <reportId> [--limit N]
  fsdither compare <datasetId|--reports a b>
  fsdither export <reportId> --format json|pgm|pgm-ascii [--out file]

环境变量:
  DATA_DIR   SQLite 与默认导出目录，默认 ./data
  PORT       HTTP 端口，未设置时自动选择空闲端口`;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options.set(arg.slice(2), next);
        index += 1;
      } else {
        options.set(arg.slice(2), "true");
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function openStore(): DitherStore {
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  return new DitherStore(join(dataDir, "floyd.sqlite"));
}

function ascii(matrix: number[][]): string {
  return matrix.map((row) => row.map((value) => (value === 255 ? "█" : "·")).join(" ")).join("\n");
}

function printResult(title: string, matrix: number[][]): void {
  const result = runDithering(matrix, title === "蛇形扩散" ? "serpentine" : "lr");
  console.log(`\n[${title}] 平均原灰度=${matrixAverage(matrix).toFixed(3)}，平均输出=${matrixAverage(result.output).toFixed(3)}`);
  console.log(ascii(result.output));
  console.log(JSON.stringify(result.output));
}

function printFixed(title: string, matrix: number[][]): void {
  const output = fixedThreshold(matrix);
  console.log(`\n[${title}] 平均输出=${matrixAverage(output).toFixed(3)}`);
  console.log(ascii(output));
  console.log(JSON.stringify(output));
}

function runDemo(): void {
  const constant: number[][] = [
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [100, 100, 100, 100],
  ];
  const gradient: number[][] = [
    [0, 36, 72, 108, 144, 180, 216, 255],
    [0, 36, 72, 108, 144, 180, 216, 255],
  ];
  const checker: number[][] = [
    [0, 255, 0, 255],
    [255, 0, 255, 0],
    [0, 255, 0, 255],
    [255, 0, 255, 0],
  ];
  const known: number[][] = [[128, 128]];

  for (const [name, matrix] of [
    ["已知 [128,128]", known],
    ["常量灰度", constant],
    ["水平渐变", gradient],
    ["小棋盘", checker],
  ] as const) {
    console.log(`\n========== ${name} ==========`);
    printFixed("固定阈值", [...matrix.map((row) => [...row])]);
    printResult("从左向右扩散", [...matrix.map((row) => [...row])]);
    const serpentine = runDithering(matrix, "serpentine");
    console.log(`\n[蛇形扩散] 平均输出=${matrixAverage(serpentine.output).toFixed(3)}`);
    console.log(ascii(serpentine.output));
    console.log(JSON.stringify(serpentine.output));
    console.log("账目:", JSON.stringify(serpentine.summary, null, 2));
  }

  const knownResult = runDithering(known, "lr");
  const second = knownResult.pixels[1]!;
  console.log("\n已知用例核验:");
  console.log(`输出=${JSON.stringify(knownResult.output)}`);
  console.log(`第二像素工作值=${second.workingValue}（期望 72.4375）`);
  console.log(`边界丢弃误差合计=${knownResult.summary.discardedErrorSum}（期望 1）`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command === "demo") {
    runDemo();
    return;
  }

  const { positional, options } = parseArgs(rest);
  const store = openStore();
  try {
    if (command === "import") {
      const file = positional[0];
      if (!file) throw new ApiError("MISSING_ARGUMENT", "需要 matrix.json 文件路径");
      const matrix = validateMatrix(JSON.parse(readFileSync(file, "utf8")) as unknown);
      console.log(JSON.stringify(store.importMatrix(matrix), null, 2));
      return;
    }
    if (command === "run") {
      const datasetId = positional[0];
      if (!datasetId) throw new ApiError("MISSING_ARGUMENT", "需要 datasetId");
      const mode = validateMode(options.get("mode"));
      const rawBudget = options.get("trace-budget");
      const traceBudget = rawBudget ? Number(rawBudget) : null;
      if (traceBudget !== null && (!Number.isInteger(traceBudget) || traceBudget < 0)) {
        throw new ApiError("INVALID_LIMIT", "--trace-budget 必须是非负整数");
      }
      const { report, created } = store.createReport(datasetId, mode, traceBudget);
      console.log(JSON.stringify({ created, ...report }, null, 2));
      return;
    }
    if (command === "pixel") {
      const [reportId, rowText, colText] = positional;
      if (!reportId || rowText === undefined || colText === undefined) {
        throw new ApiError("MISSING_ARGUMENT", "需要 reportId row col");
      }
      const report = store.getReportOrThrow(reportId);
      console.log(JSON.stringify(getPixel(report.result, Number(rowText), Number(colText)), null, 2));
      return;
    }
    if (command === "trace") {
      const reportId = positional[0];
      if (!reportId) throw new ApiError("MISSING_ARGUMENT", "需要 reportId");
      const report = store.getReportOrThrow(reportId);
      const limit = options.get("limit") === undefined ? undefined : Number(options.get("limit"));
      console.log(JSON.stringify(traceSteps(report.result, limit), null, 2));
      return;
    }
    if (command === "compare") {
      const reportIds = options.get("reports");
      if (reportIds) {
        const [firstId, secondId] = reportIds.split(" ");
        if (!firstId || !secondId) throw new ApiError("MISSING_ARGUMENT", '--reports 需要 "a b"');
        const first = store.getReportOrThrow(firstId);
        const second = store.getReportOrThrow(secondId);
        console.log(JSON.stringify(compareResults(first.result, second.result), null, 2));
      } else {
        const datasetId = positional[0];
        if (!datasetId) throw new ApiError("MISSING_ARGUMENT", "需要 datasetId 或 --reports");
        const first = store.createReport(datasetId, "lr").report;
        const second = store.createReport(datasetId, "serpentine").report;
        console.log(JSON.stringify({
          firstReportId: first.id,
          secondReportId: second.id,
          comparison: compareResults(first.result, second.result),
        }, null, 2));
      }
      return;
    }
    if (command === "export") {
      const reportId = positional[0];
      if (!reportId) throw new ApiError("MISSING_ARGUMENT", "需要 reportId");
      const format = options.get("format") ?? "json";
      const report = store.getReportOrThrow(reportId);
      let content: string | Buffer;
      if (format === "json") {
        content = JSON.stringify({
          output: report.result.output,
          mode: report.mode,
          boundaryPolicy: report.boundaryPolicy,
          ruleVersion: report.ruleVersion,
          summary: report.result.summary,
        }, null, 2);
      } else if (format === "pgm") {
        content = toBinaryPGM(report.result.output);
      } else if (format === "pgm-ascii") {
        content = toAsciiPGM(report.result.output);
      } else {
        throw new ApiError("INVALID_FORMAT", "format 必须是 json、pgm 或 pgm-ascii");
      }
      const out = options.get("out");
      if (out) writeFileSync(out, content);
      else if (Buffer.isBuffer(content)) process.stdout.write(content);
      else console.log(content);
      return;
    }
    console.error(usage());
    exitCode = 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
    console.error(JSON.stringify({ error: { code, message } }, null, 2));
    exitCode = 1;
  } finally {
    store.close();
  }
}

let exitCode = 0;
main().then(() => exit(exitCode)).catch((error: unknown) => {
  console.error(error);
  exit(1);
});
