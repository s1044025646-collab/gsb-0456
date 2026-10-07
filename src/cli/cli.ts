#!/usr/bin/env node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { Store } from '../db.js';
import { dither, toPGM } from '../dither.js';
import { DEFAULT_LIMITS } from '../validation.js';
import { startServer } from '../server.js';
import { DitherService } from '../service.js';

const DATA_DIR = process.env.FS_DITHER_DATA_DIR
  ? resolve(process.env.FS_DITHER_DATA_DIR)
  : resolve(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'dither.db');

function openService(): DitherService {
  return new DitherService(new Store(DB_PATH), DEFAULT_LIMITS);
}

function parseJsonArg(value: string): unknown {
  const text = value.startsWith('@')
    ? readFileSync(resolve(value.slice(1)), 'utf8')
    : value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`无法解析 JSON：${value}`);
  }
}

function readMatrixArg(value: string): unknown {
  if (value === '@-' || value === '-') {
    return JSON.parse(readFileSync(0, 'utf8')) as unknown;
  }
  return parseJsonArg(value);
}

function charMap(matrix: number[][]): string {
  return matrix.map((row) => row.map((v) => (v === 255 ? '█' : '·')).join(' ')).join('\n');
}

function numMap(matrix: number[][]): string {
  return matrix.map((row) => '[' + row.map((v) => String(v).padStart(3)).join(', ') + ']').join('\n');
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(6);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'serve': {
      const portArg = rest.find((a) => a.startsWith('--port='))?.split('=')[1];
      const port = portArg === undefined ? 0 : Number(portArg);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`非法端口：${portArg ?? ''}`);
        return 2;
      }
      const { port: actual } = await startServer(openService(), port);
      console.log(`Floyd–Steinberg 后端已启动: http://127.0.0.1:${actual}`);
      console.log(`数据目录: ${DATA_DIR}`);
      console.log('默认端口 0 = 由操作系统选择空闲端口；可用 --port=8080 指定。');
      return 0;
    }
    case 'import': {
      if (rest.length < 1) return usage('import <矩阵JSON|@文件.json|->');
      const r = openService().importMatrix(readMatrixArg(rest[0]!));
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'run': {
      if (rest.length < 1) return usage('run <datasetId> [--mode=lr|serpentine] [--boundary=discard]');
      const mode = option(rest, '--mode') ?? 'lr';
      const boundary = option(rest, '--boundary') ?? 'discard';
      const r = openService().runReport(rest[0]!, mode, boundary);
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'report': {
      if (rest.length < 1) return usage('report <reportId> [--budget=N]');
      const view = openService().getReport(rest[0]!, option(rest, '--budget'));
      console.log('输出矩阵：');
      console.log(numMap(view.output));
      console.log('\n字符图（█=白255, ·=黑0）：');
      console.log(charMap(view.output));
      const s = view.summary;
      console.log('\n汇总：');
      console.log(
        `  尺寸 ${s.width}x${s.height}  黑 ${s.blackCount}  白 ${s.whiteCount}\n` +
          `  原均值 ${fmt(s.originalMean)}  输出均值 ${fmt(s.outputMean)}\n` +
          `  原总和 ${s.originalSum}  输出总和 ${s.outputSum}\n` +
          `  边界丢弃(有符号) ${fmt(s.discardedSum)}  账目差 ${fmt(s.conservationGap)}\n` +
          `  容差 ${fmt(s.tolerance)}  守恒核验 ${s.conservationVerified ? '通过' : '失败'}`,
      );
      console.log(`\n详细记录：${view.truncation.explanation}`);
      return 0;
    }
    case 'pixel': {
      if (rest.length < 3) return usage('pixel <reportId> <row> <col>');
      console.log(JSON.stringify(openService().getPixel(rest[0]!, rest[1], rest[2]), null, 2));
      return 0;
    }
    case 'steps': {
      if (rest.length < 1) return usage('steps <reportId> [--budget=N]');
      console.log(JSON.stringify(openService().getSteps(rest[0]!, option(rest, '--budget')), null, 2));
      return 0;
    }
    case 'compare': {
      if (rest.length < 1) return usage('compare <datasetId>');
      const r = openService().compare(rest[0]!);
      console.log(`规则版本 ${r.ruleVersion}  容差/像素 ${r.tolerancePerCell}`);
      for (const [name, part] of [
        ['固定阈值', r.fixedThreshold],
        ['普通扩散 lr', r.lr],
        ['蛇形 serpentine', r.serpentine],
      ] as const) {
        console.log(`\n== ${name} ==`);
        console.log(numMap(part.output));
        console.log(charMap(part.output));
        console.log(
          `黑 ${part.blackCount} 白 ${part.whiteCount} ` +
            `原均值 ${fmt(part.originalMean)} 输出均值 ${fmt(part.outputMean)}` +
            ('conservationVerified' in part
              ? ` 守恒 ${part.conservationVerified ? '通过' : '失败'}`
              : ' (固定阈值无误差账目)'),
        );
      }
      console.log(`\n${r.note}`);
      return 0;
    }
    case 'export': {
      if (rest.length < 2) return usage('export <reportId> <outFile.pgm|outFile.json> [--layer=output|json|original]');
      const svc = openService();
      const file = svc.exportMatrix(rest[0]!, option(rest, '--layer') ?? 'output');
      writeFileSync(resolve(rest[1]!), file.body);
      console.log(`已写出 ${rest[1]} (${file.media}, ${file.body.length} 字节)`);
      return 0;
    }
    case 'demo':
      return runDemo();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return 0;
    default:
      console.error(`未知命令：${cmd}`);
      printHelp();
      return 2;
  }
}

function option(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.split('=')[1];
}

function usage(syntax: string): number {
  console.error(`用法: fs-dither ${syntax}`);
  return 2;
}

function printHelp(): void {
  console.log([
    'fs-dither — Floyd–Steinberg 二值化与误差传播核验后端',
    '',
    '用法:',
    '  serve [--port=0]                    启动 HTTP API（默认让系统选空闲端口）',
    '  import <矩阵JSON|@file.json|->      导入数据集（重复矩阵返回原 ID）',
    '  run <datasetId> [--mode=lr|serpentine] [--boundary=discard]',
    '  report <reportId> [--budget=N]      输出矩阵、字符图、均值与误差汇总',
    '  pixel <reportId> <row> <col>        查询单像素误差来源与分配',
    '  steps <reportId> [--budget=N]       查看有限传播步骤（预算只截断展示）',
    '  compare <datasetId>                 固定阈值 vs 普通扩散 vs 蛇形',
    '  export <reportId> <out> [--layer=output|json|original]',
    '  demo                                运行内置样例演示',
    '  help',
    '',
    '环境变量:',
    '  FS_DITHER_DATA_DIR   数据目录（默认 ./data），SQLite 文件为 dither.db',
  ].join('\n'));
}

function runDemo(): number {
  const svc = openService();
  console.log('=== 已知样例 [128,128]（普通 lr）===');
  const kRes = dither([[128, 128]], { mode: 'lr', boundary: 'discard' });
  console.log(numMap(kRes.output));
  console.log(charMap(kRes.output));
  for (const p of kRes.pixels) {
    console.log(
      `(${p.row},${p.col}) 原 ${p.original} 收误差 ${fmt(p.receivedError)} 工作值 ${fmt(p.workingValue)} 出 ${p.output} 待分配 ${fmt(p.carryError)} 丢弃 ${fmt(p.discarded)}`,
    );
  }
  console.log(
    `断言：输出 [255,0]，第二工作值 72.4375，丢弃合计 1，守恒 ${kRes.summary.conservationVerified ? '通过' : '失败'}`,
  );

  const constant = Array.from({ length: 6 }, () => new Array<number>(12).fill(100));
  const gradient = [Array.from({ length: 16 }, (_, c) => Math.round((c * 255) / 15))];
  const checker = Array.from({ length: 6 }, (_, r) =>
    Array.from({ length: 6 }, (_, c) => ((r + c) % 2 === 0 ? 40 : 220)),
  );

  for (const [label, m] of [
    ['常量灰度 100 (6x12)', constant],
    ['水平渐变 (1x16)', gradient],
    ['小棋盘 40/220 (6x6)', checker],
  ] as const) {
    console.log(`\n=== ${label} ===`);
    const imported = svc.importMatrix(m);
    const cmp = svc.compare(imported.id);
    for (const [name, part] of [
      ['固定阈值', cmp.fixedThreshold],
      ['普通扩散', cmp.lr],
      ['蛇形扩散', cmp.serpentine],
    ] as const) {
      console.log(`-- ${name}  输出均值 ${fmt(part.outputMean)}（原均值 ${fmt(part.originalMean)}）`);
      console.log(charMap(part.output));
    }
  }

  const ds = svc.importMatrix(gradient);
  const rp = svc.runReport(ds.id, 'serpentine', 'discard');
  const dir = mkdtempSync(join(tmpdir(), 'fs-dither-'));
  const out = join(dir, 'gradient.pgm');
  writeFileSync(out, toPGM(svc.getReport(rp.id).output));
  console.log(`\n蛇形渐变 PGM 已导出（无需图像窗口）: ${out}`);
  console.log('数据目录:', DATA_DIR);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const e = err as { code?: string; message?: string };
    console.error(`失败${e.code ? ` [${e.code}]` : ''}: ${e.message ?? String(err)}`);
    process.exitCode = 1;
  });
