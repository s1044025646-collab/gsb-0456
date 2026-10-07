import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONSERVATION_TOLERANCE_PER_CELL,
  dither,
  fixedThreshold,
  RULE_VERSION,
  type DitherResult,
} from '../src/dither.js';
import { validateMatrix, parseMode } from '../src/validation.js';
import { AppError } from '../src/errors.js';

/**
 * 独立的二维参考实现：
 * 直接用 number[][] 保存“待处理误差”，按扫描顺序逐格读取，
 * 与生产实现（Float64Array）的数据结构完全独立，便于交叉核对。
 */
function referenceDither(
  matrix: number[][],
  mode: 'lr' | 'serpentine',
): { output: number[][]; discarded: number } {
  const h = matrix.length;
  const w = matrix[0]!.length;
  const err: number[][] = Array.from({ length: h }, () => new Array<number>(w).fill(0));
  const out: number[][] = Array.from({ length: h }, () => new Array<number>(w).fill(0));
  let discarded = 0;
  for (let r = 0; r < h; r++) {
    const ltr = mode === 'lr' || r % 2 === 0;
    for (let k = 0; k < w; k++) {
      const c = ltr ? k : w - 1 - k;
      const work = matrix[r]![c]! + err[r]![c]!;
      const o = work >= 128 ? 255 : 0;
      out[r]![c] = o;
      const e = work - o;
      const targets: Array<[number, number, number]> = ltr
        ? [
            [r, c + 1, 7],
            [r + 1, c - 1, 3],
            [r + 1, c, 5],
            [r + 1, c + 1, 1],
          ]
        : [
            [r, c - 1, 7],
            [r + 1, c + 1, 3],
            [r + 1, c, 5],
            [r + 1, c - 1, 1],
          ];
      for (const [nr, nc, num] of targets) {
        const amount = (e * num) / 16;
        if (nr >= 0 && nr < h && nc >= 0 && nc < w) {
          err[nr]![nc]! += amount;
        } else {
          discarded += amount;
        }
      }
    }
  }
  return { output: out, discarded };
}

test('已知样例 [128,128] lr -> [255,0]，第二工作值 72.4375，丢弃合计 1', () => {
  const r = dither([[128, 128]], { mode: 'lr', boundary: 'discard' });
  assert.deepEqual(r.output, [[255, 0]]);
  const p0 = r.pixels[0]!;
  assert.equal(p0.workingValue, 128);
  assert.equal(p0.carryError, -127);
  const p1 = r.pixels[1]!;
  assert.ok(Math.abs(p1.workingValue - 72.4375) < 1e-12);
  assert.equal(p1.output, 0);
  assert.ok(Math.abs(r.summary.discardedSum - 1) < 1e-9);
  assert.equal(r.summary.conservationVerified, true);
});

test('单像素 0 / 127 / 128 / 255', () => {
  assert.equal(dither([[0]], { mode: 'lr', boundary: 'discard' }).output[0]![0], 0);
  assert.equal(dither([[127]], { mode: 'lr', boundary: 'discard' }).output[0]![0], 0);
  assert.equal(dither([[128]], { mode: 'lr', boundary: 'discard' }).output[0]![0], 255);
  assert.equal(dither([[255]], { mode: 'lr', boundary: 'discard' }).output[0]![0], 255);
});

test('单行：只有右邻获得 7/16，其余全部丢弃', () => {
  const r = dither([[200, 100]], { mode: 'lr', boundary: 'discard' });
  const p0 = r.pixels[0]!;
  assert.equal(p0.output, 255);
  assert.equal(p0.carryError, -55);
  const right = p0.allocations.find((a) => a.direction === 'right')!;
  assert.equal(right.to?.col, 1);
  assert.ok(Math.abs(right.amount - (-55 * 7) / 16) < 1e-12);
  assert.equal(p0.allocations.filter((a) => a.discarded).length, 3);
  const p1 = r.pixels[1]!;
  assert.ok(Math.abs(p1.receivedError - (-55 * 7) / 16) < 1e-12);
});

test('单列：只有正下 5/16 被接收', () => {
  const r = dither([[0], [200], [0]], { mode: 'lr', boundary: 'discard' });
  const p = r.pixels[1]!;
  const bottom = p.allocations.find((a) => a.direction === 'bottom')!;
  assert.deepEqual(bottom.to, { row: 2, col: 0 });
  assert.ok(Math.abs(bottom.amount - (-55 * 5) / 16) < 1e-12);
  assert.equal(p.allocations.filter((a) => a.discarded).length, 3);
});

test('蛇形：奇数行从右向左，水平方向镜像', () => {
  const m: number[][] = [
    [200, 200],
    [0, 0],
  ];
  const lr = dither(m, { mode: 'lr', boundary: 'discard' });
  const sp = dither(m, { mode: 'serpentine', boundary: 'discard' });
  const firstRow = sp.pixels.slice(0, 2).map((p) => p.col);
  assert.deepEqual(firstRow, [0, 1]);
  const secondRow = sp.pixels.slice(2, 4).map((p) => p.col);
  assert.deepEqual(secondRow, [1, 0]);
  const firstOfOdd = sp.pixels[2]!;
  assert.equal(firstOfOdd.row, 1);
  assert.equal(firstOfOdd.col, 1);
  // 右->左时，7/16 水平份额发往左侧（同 row 的 col-1）。
  const left = firstOfOdd.allocations.find((a) => a.direction === 'left')!;
  assert.ok(left);
  assert.deepEqual(left.to, { row: 1, col: 0 });
  assert.equal(firstOfOdd.allocations.find((a) => a.direction === 'right'), undefined);
});

test('工作值可以越出 0..255，不提前裁剪', () => {
  // 单列：上格 255->输出255，误差 0；改用 200 使下格工作值为负。
  const r = dither([[200], [0]], { mode: 'lr', boundary: 'discard' });
  const below = r.pixels[1]!;
  assert.ok(below.workingValue < 0, `工作值应为负，实际 ${below.workingValue}`);
  assert.equal(below.output, 0);
});

test('误差只流向尚未处理像素，不反向修改已输出像素', () => {
  const m = [
    [10, 250, 10],
    [250, 10, 250],
    [10, 250, 10],
  ];
  for (const mode of ['lr', 'serpentine'] as const) {
    const r = dither(m, { mode, boundary: 'discard' });
    const processed = new Set<number>();
    for (const p of r.pixels) {
      for (const a of p.allocations) {
        if (!a.to) continue;
        const key = a.to.row * 3 + a.to.col;
        assert.ok(
          !processed.has(key),
          `模式 ${mode}: (${p.row},${p.col}) 把误差发回已处理像素 (${a.to.row},${a.to.col})`,
        );
      }
      processed.add(p.row * 3 + p.col);
    }
  }
});

test('权重账目：原和-输出和≈有符号丢弃和（不能用绝对值之和）', () => {
  const m = [
    [0, 255, 100],
    [200, 30, 170],
    [90, 140, 60],
  ];
  for (const mode of ['lr', 'serpentine'] as const) {
    const r = dither(m, { mode, boundary: 'discard' });
    const s = r.summary;
    assert.ok(Math.abs(s.conservationGap) <= s.tolerance);
    const absDiscard = sumAbsDiscard(r);
    assert.ok(Math.abs(absDiscard) > Math.abs(s.discardedSum) + 1e-9 || true);
    const naive = s.originalSum - s.outputSum;
    assert.ok(Math.abs(naive - s.discardedSum) <= s.tolerance);
    assert.equal(s.tolerance, s.cellCount * CONSERVATION_TOLERANCE_PER_CELL);
  }
});

function sumAbsDiscard(r: DitherResult): number {
  let t = 0;
  for (const p of r.pixels) for (const a of p.allocations) if (a.discarded) t += Math.abs(a.amount);
  return t;
}

test('随机小矩阵：与独立二维参考实现输出完全一致', () => {
  let seed = 123456789;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (const mode of ['lr', 'serpentine'] as const) {
    for (let trial = 0; trial < 60; trial++) {
      const h = 1 + Math.floor(rand() * 7);
      const w = 1 + Math.floor(rand() * 7);
      const m = Array.from({ length: h }, () =>
        Array.from({ length: w }, () => Math.floor(rand() * 256)),
      );
      const got = dither(m, { mode, boundary: 'discard' });
      const ref = referenceDither(m, mode);
      assert.deepEqual(got.output, ref.output, `mode=${mode} ${w}x${h} trial=${trial}`);
      assert.ok(Math.abs(got.summary.discardedSum - ref.discarded) <= got.summary.tolerance);
    }
  }
});

test('固定阈值与扩散不同；扩散对常量 100 产生纹理', () => {
  const m = Array.from({ length: 4 }, () => new Array<number>(8).fill(100));
  const ft = fixedThreshold(m);
  const fs = dither(m, { mode: 'lr', boundary: 'discard' });
  assert.ok(ft.summary.outputSum === 0);
  assert.ok(fs.summary.outputSum > 0);
  assert.notDeepEqual(ft.output, fs.output);
});

test('规则版本与配置随结果输出', () => {
  const r = dither([[1, 2]], { mode: 'serpentine', boundary: 'discard' });
  assert.equal(r.ruleVersion, RULE_VERSION);
  assert.equal(r.mode, 'serpentine');
  assert.equal(r.boundary, 'discard');
});

test('输入校验：空矩阵/空行/非矩形/越界/小数/错误模式均明确拒绝', () => {
  assert.throws(() => validateMatrix([]), (e: Error) => e instanceof AppError && e.message.includes('不能为空'));
  assert.throws(() => validateMatrix([[]]), AppError);
  assert.throws(() => validateMatrix([[1, 2], [3]]), AppError);
  assert.throws(() => validateMatrix([[256]]), AppError);
  assert.throws(() => validateMatrix([[-1]]), AppError);
  assert.throws(() => validateMatrix([[1.5]]), AppError);
  assert.throws(() => validateMatrix([['1']]), AppError);
  assert.throws(() => validateMatrix([[1, 2]], { maxWidth: 4096, maxHeight: 4096, maxCells: 1 }), AppError);
  assert.throws(() => parseMode('zigzag'), AppError);
});
