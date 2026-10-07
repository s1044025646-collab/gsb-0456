import type { BoundaryPolicy, ScanMode } from './validation.js';

/** 规则版本：Floyd–Steinberg，阈值 128（含等于 128 输出 255），边界丢弃。 */
export const RULE_VERSION = 'floyd-steininberg-1.0';

/**
 * 公开浮点容差（单位：灰度级 / 像素）。
 * 账目核验使用：|原灰度和 - 输出和 - 边界丢弃和| <= 像素数 * 本容差。
 * 权重为 1/16 的二进制浮点表示，误差按 IEEE-754 double 逐次累加，
 * 因此理论账目会有极小的舍入残差，不做整数化或逐次取整。
 */
export const CONSERVATION_TOLERANCE_PER_CELL = 1e-9;

export interface Allocation {
  /** 目标坐标（在图像内）；越界份额目标为 null。 */
  to: { row: number; col: number } | null;
  /** 权重，例如 7/16。 */
  weight: number;
  /** 权重方向名称。 */
  direction: string;
  /** 实际误差值 = 待分配误差 * weight（有符号）。 */
  amount: number;
  /** 是否越界丢弃。 */
  discarded: boolean;
}

export interface PixelRecord {
  row: number;
  col: number;
  /** 扫描顺序中的处理序号（0 起）。 */
  order: number;
  /** 原始灰度 0..255（永不修改）。 */
  original: number;
  /** 处理前累计收到的误差（有符号，可使工作值越出 0..255）。 */
  receivedError: number;
  /** 工作值 = original + receivedError，不提前裁剪。 */
  workingValue: number;
  /** 二值输出：workingValue >= 128 -> 255，否则 0。 */
  output: 0 | 255;
  /** 本像素待分配误差 = workingValue - output。 */
  carryError: number;
  /** 该像素丢弃到边界外的误差（有符号之和）。 */
  discarded: number;
  allocations: Allocation[];
}

export interface DitherSummary {
  width: number;
  height: number;
  cellCount: number;
  originalSum: number;
  outputSum: number;
  originalMean: number;
  outputMean: number;
  blackCount: number;
  whiteCount: number;
  /** 边界丢弃误差总和（有符号数相加，不是绝对值之和）。 */
  discardedSum: number;
  /** 原灰度和 - 输出和 - discardedSum 的差值。 */
  conservationGap: number;
  /** 公开容差 = cellCount * CONSERVATION_TOLERANCE_PER_CELL。 */
  tolerance: number;
  /** gap 是否在公开容差内。 */
  conservationVerified: boolean;
}

export interface DitherOptions {
  mode: ScanMode;
  boundary: BoundaryPolicy;
}

export interface DitherResult {
  output: number[][];
  pixels: PixelRecord[];
  summary: DitherSummary;
  ruleVersion: string;
  mode: ScanMode;
  boundary: BoundaryPolicy;
  /** 扫描顺序下的坐标序列。 */
  scanOrder: Array<{ row: number; col: number }>;
}

interface WeightSpec {
  dr: number;
  dc: number;
  weight: number;
  /** 左->右行的方向名。 */
  ltrName: string;
  /** 右->左行（蛇形奇数行）的方向名。 */
  rtlName: string;
}

// 左->右：右 7/16，左下 3/16，下 5/16，右下 1/16。
const LTR_WEIGHTS: ReadonlyArray<WeightSpec> = [
  { dr: 0, dc: 1, weight: 7 / 16, ltrName: 'right', rtlName: 'left' },
  { dr: 1, dc: -1, weight: 3 / 16, ltrName: 'bottom-left', rtlName: 'bottom-right' },
  { dr: 1, dc: 0, weight: 5 / 16, ltrName: 'bottom', rtlName: 'bottom' },
  { dr: 1, dc: 1, weight: 1 / 16, ltrName: 'bottom-right', rtlName: 'bottom-left' },
];

export function dither(matrix: number[][], options: DitherOptions): DitherResult {
  const height = matrix.length;
  const width = matrix[0]!.length;
  const n = width * height;

  // 误差缓冲：仅保存“尚未处理像素”累计收到的误差；已处理像素的槽位不再被写入。
  const err = new Float64Array(n);
  const output: number[][] = Array.from({ length: height }, () => new Array<number>(width));
  const pixels: PixelRecord[] = [];
  const scanOrder: Array<{ row: number; col: number }> = [];

  let originalSum = 0;
  let outputSum = 0;
  let discardedSum = 0;
  let blackCount = 0;
  let order = 0;

  for (let r = 0; r < height; r++) {
    const ltr = options.mode === 'lr' || r % 2 === 0;
    for (let k = 0; k < width; k++) {
      const c = ltr ? k : width - 1 - k;
      const idx = r * width + c;
      const original = matrix[r]![c]!;
      originalSum += original;

      const receivedError = err[idx]!;
      const workingValue = original + receivedError;
      const out: 0 | 255 = workingValue >= 128 ? 255 : 0;
      const carry = workingValue - out;
      output[r]![c] = out;
      outputSum += out;
      if (out === 0) blackCount++;

      scanOrder.push({ row: r, col: c });
      const allocations: Allocation[] = [];
      let pixelDiscarded = 0;

      for (const spec of LTR_WEIGHTS) {
        const dc = ltr ? spec.dc : -spec.dc;
        const nr = r + spec.dr;
        const nc = c + dc;
        const amount = carry * spec.weight;
        const inBounds = nr >= 0 && nr < height && nc >= 0 && nc < width;
        if (inBounds) {
          // 只可能落在尚未处理的像素：
          // 同行只向扫描前进方向；下一行尚未开始。永不回写已输出像素。
          err[nr * width + nc]! += amount;
        } else {
          pixelDiscarded += amount;
          discardedSum += amount;
        }
        allocations.push({
          to: inBounds ? { row: nr, col: nc } : null,
          weight: spec.weight,
          direction: ltr ? spec.ltrName : spec.rtlName,
          amount,
          discarded: !inBounds,
        });
      }

      pixels.push({
        row: r,
        col: c,
        order,
        original,
        receivedError,
        workingValue,
        output: out,
        carryError: carry,
        discarded: pixelDiscarded,
        allocations,
      });
      order++;
    }
  }

  const gap = originalSum - outputSum - discardedSum;
  const tolerance = n * CONSERVATION_TOLERANCE_PER_CELL;

  const summary: DitherSummary = {
    width,
    height,
    cellCount: n,
    originalSum,
    outputSum,
    originalMean: originalSum / n,
    outputMean: outputSum / n,
    blackCount,
    whiteCount: n - blackCount,
    discardedSum,
    conservationGap: gap,
    tolerance,
    conservationVerified: Math.abs(gap) <= tolerance,
  };

  return {
    output,
    pixels,
    summary,
    ruleVersion: RULE_VERSION,
    mode: options.mode,
    boundary: options.boundary,
    scanOrder,
  };
}

/** 固定阈值 128 对照：逐像素比较，不做任何误差扩散。 */
export function fixedThreshold(matrix: number[][]): {
  output: number[][];
  summary: DitherSummary;
} {
  const height = matrix.length;
  const width = matrix[0]!.length;
  const n = width * height;
  const out: number[][] = Array.from({ length: height }, () => new Array<number>(width));
  let originalSum = 0;
  let outputSum = 0;
  let blackCount = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const v = matrix[r]![c]!;
      originalSum += v;
      const o: 0 | 255 = v >= 128 ? 255 : 0;
      out[r]![c] = o;
      outputSum += o;
      if (o === 0) blackCount++;
    }
  }
  const summary: DitherSummary = {
    width,
    height,
    cellCount: n,
    originalSum,
    outputSum,
    originalMean: originalSum / n,
    outputMean: outputSum / n,
    blackCount,
    whiteCount: n - blackCount,
    discardedSum: 0,
    conservationGap: originalSum - outputSum,
    tolerance: n * CONSERVATION_TOLERANCE_PER_CELL,
    conservationVerified: false,
  };
  return { output: out, summary };
}

/** 导出二进制 PGM（P5，8 位灰度；值只有 0 和 255）。 */
export function toPGM(matrix: number[][]): Buffer {
  const height = matrix.length;
  const width = matrix[0]!.length;
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
  const body = Buffer.alloc(width * height);
  let p = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      body[p++] = matrix[r]![c]! === 0 ? 0 : 255;
    }
  }
  return Buffer.concat([header, body]);
}
