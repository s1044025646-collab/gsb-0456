import type {
  ActualReceiver,
  DitherResult,
  PixelRecord,
  ScanMode,
} from "./types.js";

export const RULE_VERSION = "floyd-steinberg-v1";

interface WeightedOffset {
  dr: number;
  dc: number;
  weight: number;
  direction: "right" | "left" | "lowerLeft" | "lowerRight" | "below";
}

const LR_WEIGHTS: WeightedOffset[] = [
  { dr: 0, dc: 1, weight: 7 / 16, direction: "right" },
  { dr: 1, dc: -1, weight: 3 / 16, direction: "lowerLeft" },
  { dr: 1, dc: 0, weight: 5 / 16, direction: "below" },
  { dr: 1, dc: 1, weight: 1 / 16, direction: "lowerRight" },
];

const SERPENTINE_REVERSE_WEIGHTS: WeightedOffset[] = [
  { dr: 0, dc: -1, weight: 7 / 16, direction: "left" },
  { dr: 1, dc: 1, weight: 3 / 16, direction: "lowerRight" },
  { dr: 1, dc: 0, weight: 5 / 16, direction: "below" },
  { dr: 1, dc: -1, weight: 1 / 16, direction: "lowerLeft" },
];

function scanOrder(height: number, width: number, mode: ScanMode) {
  const order: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < height; row += 1) {
    const reverse = mode === "serpentine" && row % 2 === 1;
    if (reverse) {
      for (let col = width - 1; col >= 0; col -= 1) order.push({ row, col });
    } else {
      for (let col = 0; col < width; col += 1) order.push({ row, col });
    }
  }
  return order;
}

export function runDithering(
  input: number[][],
  mode: ScanMode,
  traceBudget: number | null = null,
): DitherResult {
  const height = input.length;
  const width = input[0]?.length ?? 0;
  const carried = Array.from({ length: height }, () =>
    new Float64Array(width),
  );
  const output = Array.from({ length: height }, () =>
    new Array<number>(width).fill(0),
  );
  const records: PixelRecord[] = [];
  let traceComplete = true;
  let traceTruncated = false;

  let distributedErrorSum = 0;
  let discardedErrorSum = 0;
  let blackPixels = 0;
  let whitePixels = 0;
  let originalSum = 0;
  let outputSum = 0;

  scanOrder(height, width, mode).forEach(({ row, col }, scanIndex) => {
    const original = input[row]?.[col];
    if (original === undefined) throw new Error("internal invalid scan position");
    originalSum += original;

    const receivedError = carried[row]?.[col] ?? 0;
    const workingValue = original + receivedError;
    const binary: 0 | 255 = workingValue >= 128 ? 255 : 0;
    const pixelError = workingValue - binary;
    output[row]![col] = binary;
    outputSum += binary;
    if (binary === 255) blackPixels += 1;
    else whitePixels += 1;

    const weights =
      mode === "serpentine" && row % 2 === 1
        ? SERPENTINE_REVERSE_WEIGHTS
        : LR_WEIGHTS;
    const actualReceivers: ActualReceiver[] = [];

    for (const neighbor of weights) {
      const targetRow = row + neighbor.dr;
      const targetCol = col + neighbor.dc;
      const share = pixelError * neighbor.weight;
      if (targetRow >= 0 && targetRow < height && targetCol >= 0 && targetCol < width) {
        const targetRowErrors = carried[targetRow]!;
        targetRowErrors[targetCol] = targetRowErrors[targetCol]! + share;
        actualReceivers.push({
          row: targetRow,
          col: targetCol,
          weight: neighbor.weight,
          share,
        });
        distributedErrorSum += share;
      } else {
        discardedErrorSum += share;
      }
    }

    if (traceBudget === null || scanIndex < traceBudget) {
      records.push({
        row,
        col,
        scanIndex,
        original,
        receivedError,
        workingValue,
        output: binary,
        pixelError,
        actualReceivers,
      });
    } else {
      traceComplete = false;
      traceTruncated = true;
    }
  });

  const pixelCount = height * width;
  const sumDifference = originalSum - outputSum;
  const accountDifference = sumDifference - discardedErrorSum;
  const tolerance = Math.max(1e-9, pixelCount * Number.EPSILON * 256);

  return {
    width,
    height,
    mode,
    boundaryPolicy: "discard",
    ruleVersion: RULE_VERSION,
    output,
    pixels: records,
    summary: {
      originalSum,
      outputSum,
      sumDifference,
      discardedErrorSum,
      distributedErrorSum,
      blackPixels,
      whitePixels,
      originalAverage: originalSum / pixelCount,
      outputAverage: outputSum / pixelCount,
      tolerance,
      accountDifference,
      accountBalanced: Math.abs(accountDifference) <= tolerance,
    },
    calculationComplete: true,
    traceComplete,
    traceBudget,
    traceTruncated,
    truncationReason: traceTruncated
      ? `传播记录仅展示前 ${traceBudget} 个像素；正式计算仍处理 ${pixelCount} 个像素。`
      : null,
  };
}

export function fixedThreshold(input: number[][], threshold = 128): number[][] {
  return input.map((row) => row.map((value) => (value >= threshold ? 255 : 0)));
}

export function matrixAverage(matrix: number[][]): number {
  const values = matrix.flat();
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
