import { ApiError, ERROR_CODES } from "./errors.js";
import { runDithering } from "./dither.js";
import type { DitherResult, PixelRecord } from "./types.js";

export function getPixel(result: DitherResult, row: number, col: number): PixelRecord {
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    col < 0 ||
    row >= result.height ||
    col >= result.width
  ) {
    throw new ApiError(
      ERROR_CODES.INVALID_COORDINATE,
      `坐标必须位于 0..${result.height - 1} 与 0..${result.width - 1} 内`,
      404,
    );
  }
  const pixel = result.pixels.find(
    (candidate) => candidate.row === row && candidate.col === col,
  );
  if (!pixel) {
    throw new ApiError(
      ERROR_CODES.NOT_FOUND,
      "该像素在当前传播展示预算之后；正式输出仍可在 output 中读取",
      404,
    );
  }
  return pixel;
}

export function traceSteps(result: DitherResult, limit?: number): {
  pixels: PixelRecord[];
  traceComplete: boolean;
  truncated: boolean;
  reason: string | null;
} {
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new ApiError(ERROR_CODES.INVALID_LIMIT, "limit 必须是非负整数");
    }
    const pixels = result.pixels.slice(0, limit);
    const truncated = limit < result.pixels.length || result.traceTruncated;
    return {
      pixels,
      traceComplete: !truncated,
      truncated,
      reason: truncated
        ? `已按展示限制返回 ${pixels.length} 条；正式计算完整标记为 ${result.calculationComplete}`
        : null,
    };
  }
  return {
    pixels: result.pixels,
    traceComplete: result.traceComplete,
    truncated: result.traceTruncated,
    reason: result.truncationReason,
  };
}

export function compareResults(first: DitherResult, second: DitherResult) {
  let differingPixels = 0;
  const differences: Array<{ row: number; col: number; first: number; second: number }> = [];
  const height = Math.min(first.height, second.height);
  const width = Math.min(first.width, second.width);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const left = first.output[row]?.[col];
      const right = second.output[row]?.[col];
      if (left !== right) {
        differingPixels += 1;
        if (differences.length < 20 && left !== undefined && right !== undefined) {
          differences.push({ row, col, first: left, second: right });
        }
      }
    }
  }
  return {
    sameDimensions: first.width === second.width && first.height === second.height,
    sameOutput: differingPixels === 0 && first.width === second.width && first.height === second.height,
    differingPixels,
    differences,
    firstSummary: first.summary,
    secondSummary: second.summary,
  };
}

export function recomputeSummaryCheck(
  matrix: number[][],
  result: DitherResult,
) {
  const recomputed = runDithering(matrix, result.mode, result.traceBudget);
  return {
    sameOutput: JSON.stringify(recomputed.output) === JSON.stringify(result.output),
    summary: recomputed.summary,
  };
}
