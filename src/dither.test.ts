import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedThreshold, runDithering } from "./dither.js";
import { ApiError } from "./errors.js";
import { DitherStore } from "./store.js";
import { validateMatrix } from "./validation.js";

interface ReferenceEvent {
  row: number;
  col: number;
  working: number;
  output: 0 | 255;
  error: number;
}

function referenceDither(matrix: number[][], mode: "lr" | "serpentine") {
  const height = matrix.length;
  const width = matrix[0]!.length;
  const errors: number[][] = Array.from({ length: height }, () => Array(width).fill(0));
  const output: number[][] = Array.from({ length: height }, () => Array(width).fill(-1));
  const events: ReferenceEvent[] = [];
  let discarded = 0;

  for (let row = 0; row < height; row += 1) {
    const reverse = mode === "serpentine" && row % 2 === 1;
    for (let step = 0; step < width; step += 1) {
      const col = reverse ? width - 1 - step : step;
      const working = matrix[row]![col]! + errors[row]![col]!;
      const binary: 0 | 255 = working >= 128 ? 255 : 0;
      assert.equal(output[row]![col], -1, "像素不能被二次处理");
      output[row]![col] = binary;
      const error = working - binary;
      events.push({ row, col, working, output: binary, error });

      const weights = reverse
        ? [
            [0, -1, 7 / 16],
            [1, 1, 3 / 16],
            [1, 0, 5 / 16],
            [1, -1, 1 / 16],
          ]
        : [
            [0, 1, 7 / 16],
            [1, -1, 3 / 16],
            [1, 0, 5 / 16],
            [1, 1, 1 / 16],
          ];
      for (const [dr, dc, weight] of weights) {
        const nr = row + dr!;
        const nc = col + dc!;
        assert.ok(nr > row || (nr === row && (reverse ? nc < col : nc > col)), "只能送往未处理像素");
        if (nr < height && nc >= 0 && nc < width) errors[nr]![nc]! += error * weight!;
        else discarded += error * weight!;
      }
    }
  }
  return { output, events, discarded, errors };
}

test("已知 [128,128] 从左向右", () => {
  const result = runDithering([[128, 128]], "lr");
  assert.deepEqual(result.output, [[255, 0]]);
  assert.equal(result.pixels[0]!.pixelError, -127);
  assert.equal(result.pixels[1]!.workingValue, 72.4375);
  assert.equal(result.summary.discardedErrorSum, 1);
  assert.equal(result.summary.accountBalanced, true);
});

test("单像素零、满灰与阈值 128", () => {
  assert.deepEqual(runDithering([[0]], "lr").output, [[0]]);
  assert.deepEqual(runDithering([[255]], "lr").output, [[255]]);
  assert.deepEqual(runDithering([[127]], "lr").output, [[0]]);
  assert.deepEqual(runDithering([[128]], "lr").output, [[255]]);
});

test("单行和单列只丢弃越界份额", () => {
  const row = runDithering([[0, 200, 40, 250]], "lr");
  const referenceRow = referenceDither([[0, 200, 40, 250]], "lr");
  assert.deepEqual(row.output, referenceRow.output);
  assert.ok(Math.abs(row.summary.discardedErrorSum - referenceRow.discarded) < 1e-10);

  const column = runDithering([[20], [220], [30], [240]], "lr");
  const referenceColumn = referenceDither([[20], [220], [30], [240]], "lr");
  assert.deepEqual(column.output, referenceColumn.output);
  assert.ok(Math.abs(column.summary.discardedErrorSum - referenceColumn.discarded) < 1e-10);
});

test("工作值可越界且不提前裁剪或取整", () => {
  const above = runDithering([[127, 255], [0, 0]], "lr");
  const below = runDithering([[128], [0]], "lr");
  const outside = [...above.pixels, ...below.pixels].filter(
    (pixel) => pixel.workingValue < 0 || pixel.workingValue > 255,
  );
  assert.ok(outside.length > 0);
  for (const pixel of [...above.pixels, ...below.pixels]) {
    assert.ok(Number.isFinite(pixel.workingValue));
    assert.ok(!Number.isInteger(pixel.workingValue) || pixel.workingValue === pixel.original + pixel.receivedError);
  }
});

test("蛇形奇数行从右向左并镜像权重", () => {
  const matrix = [
    [20, 240, 30, 230],
    [220, 40, 210, 50],
    [60, 200, 70, 190],
  ];
  const result = runDithering(matrix, "serpentine");
  const reference = referenceDither(matrix, "serpentine");
  assert.deepEqual(result.output, reference.output);
  assert.deepEqual(result.pixels.map((pixel) => [pixel.row, pixel.col]), [
    [0, 0], [0, 1], [0, 2], [0, 3],
    [1, 3], [1, 2], [1, 1], [1, 0],
    [2, 0], [2, 1], [2, 2], [2, 3],
  ]);
  const reversePixel = result.pixels.find((pixel) => pixel.row === 1 && pixel.col === 3)!;
  assert.deepEqual(reversePixel.actualReceivers.map((receiver) => [receiver.row, receiver.col, receiver.weight]), [
    [1, 2, 7 / 16],
    [2, 3, 5 / 16],
    [2, 2, 1 / 16],
  ]);
  for (let index = 0; index < result.pixels.length; index += 1) {
    assert.equal(result.pixels[index]!.workingValue, reference.events[index]!.working);
  }
});

test("随机小矩阵与独立二维参考完全一致并满足有符号账目", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    let state = seed * 7919 + 13;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const height = 1 + Math.floor(random() * 6);
    const width = 1 + Math.floor(random() * 7);
    const matrix = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => Math.floor(random() * 256)),
    );
    for (const mode of ["lr", "serpentine"] as const) {
      const result = runDithering(matrix, mode);
      const reference = referenceDither(matrix, mode);
      assert.deepEqual(result.output, reference.output);
      assert.ok(Math.abs(result.summary.discardedErrorSum - reference.discarded) < 1e-9);
      assert.ok(Math.abs(result.summary.accountDifference) <= result.summary.tolerance);
      assert.ok(result.summary.discardedErrorSum !== 0 || Math.abs(result.summary.sumDifference) < 1e-9);
    }
  }
});

test("固定阈值不是误差扩散", () => {
  assert.deepEqual(fixedThreshold([[127, 128]]), [[0, 255]]);
  assert.notDeepEqual(
    fixedThreshold([[127, 127, 127]]),
    runDithering([[127, 127, 127]], "lr").output,
  );
});

test("拒绝非法矩阵且不报告成功", () => {
  assert.throws(() => validateMatrix([]), ApiError);
  assert.throws(() => validateMatrix([[]]), ApiError);
  assert.throws(() => validateMatrix([[1, 2], [3]]), ApiError);
  assert.throws(() => validateMatrix([[0, 1.5]]), ApiError);
  assert.throws(() => validateMatrix([[0, 256]]), ApiError);
  assert.throws(() => validateMatrix([[0, "1"]]), ApiError);
  assert.throws(() => validateMatrix(Array.from({ length: 513 }, () => [0])), ApiError);
});

let tempDir = "";
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

test("SQLite 幂等创建报告，改变模式不覆盖旧结果", () => {
  tempDir = mkdtempSync(join(tmpdir(), "fsdither-"));
  const dbPath = join(tempDir, "test.sqlite");
  let store = new DitherStore(dbPath);
  const dataset = store.importMatrix([[100, 200], [20, 220]]);
  const first = store.createReport(dataset.id, "lr");
  const firstRepeat = store.createReport(dataset.id, "lr");
  const second = store.createReport(dataset.id, "serpentine");
  assert.equal(first.created, true);
  assert.equal(firstRepeat.created, false);
  assert.equal(first.report.id, firstRepeat.report.id);
  assert.notEqual(first.report.id, second.report.id);
  store.close();

  store = new DitherStore(dbPath);
  const reopened = store.getReportOrThrow(first.report.id);
  assert.deepEqual(reopened.result.output, first.report.result.output);
  assert.equal(reopened.mode, "lr");
  assert.equal(reopened.boundaryPolicy, "discard");
  assert.equal(reopened.ruleVersion, "floyd-steinberg-v1");
  store.close();
});

test("展示预算只截断记录不改变正式输出", () => {
  const matrix = [[10, 200, 30], [210, 40, 230]];
  const full = runDithering(matrix, "lr");
  const limited = runDithering(matrix, "lr", 2);
  assert.deepEqual(limited.output, full.output);
  assert.equal(limited.calculationComplete, true);
  assert.equal(limited.traceComplete, false);
  assert.equal(limited.pixels.length, 2);
  assert.match(limited.truncationReason!, /正式计算/);
});
