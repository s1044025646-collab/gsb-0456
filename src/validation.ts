import { ApiError, ERROR_CODES } from "./errors.js";
import type { BoundaryPolicy, ScanMode } from "./types.js";

export const MAX_DIMENSION = 512;
export const MAX_PIXELS = 20_000;

export interface Limits {
  maxDimension?: number;
  maxPixels?: number;
}

export function validateMatrix(value: unknown, limits: Limits = {}): number[][] {
  if (!Array.isArray(value)) {
    throw new ApiError(ERROR_CODES.INVALID_JSON, "matrix 必须是二维整数数组");
  }
  if (value.length === 0) {
    throw new ApiError(ERROR_CODES.EMPTY_MATRIX, "矩阵至少需要一行");
  }

  const maxDimension = limits.maxDimension ?? MAX_DIMENSION;
  const maxPixels = limits.maxPixels ?? MAX_PIXELS;
  const matrix: number[][] = [];
  const width = Array.isArray(value[0]) ? value[0].length : 0;

  if (width === 0) {
    throw new ApiError(ERROR_CODES.EMPTY_ROW, "矩阵不能包含空行");
  }
  if (value.length > maxDimension || width > maxDimension) {
    throw new ApiError(
      ERROR_CODES.MATRIX_TOO_LARGE,
      `宽高均不得超过 ${maxDimension}`,
    );
  }
  if (value.length * width > maxPixels) {
    throw new ApiError(
      ERROR_CODES.MATRIX_TOO_LARGE,
      `元素总数不得超过 ${maxPixels}`,
    );
  }

  for (let row = 0; row < value.length; row += 1) {
    const inputRow = value[row];
    if (!Array.isArray(inputRow)) {
      throw new ApiError(ERROR_CODES.INVALID_JSON, `第 ${row} 行不是数组`);
    }
    if (inputRow.length !== width) {
      throw new ApiError(
        ERROR_CODES.RAGGED_MATRIX,
        `第 ${row} 行长度为 ${inputRow.length}，应为 ${width}；只接受矩形矩阵`,
      );
    }
    const outputRow: number[] = [];
    for (let col = 0; col < width; col += 1) {
      const pixel = inputRow[col];
      if (typeof pixel !== "number" || !Number.isInteger(pixel)) {
        throw new ApiError(
          ERROR_CODES.INVALID_PIXEL_TYPE,
          `坐标 (${row},${col}) 不是整数`,
        );
      }
      if (pixel < 0 || pixel > 255) {
        throw new ApiError(
          ERROR_CODES.PIXEL_OUT_OF_RANGE,
          `坐标 (${row},${col}) 的值 ${pixel} 超出 0..255`,
        );
      }
      outputRow.push(pixel);
    }
    matrix.push(outputRow);
  }
  return matrix;
}

export function validateMode(value: unknown): ScanMode {
  if (value !== "lr" && value !== "serpentine") {
    throw new ApiError(
      ERROR_CODES.INVALID_MODE,
      "mode 必须是 lr 或 serpentine",
    );
  }
  return value;
}

export function validateBoundaryPolicy(value: unknown): BoundaryPolicy {
  const policy = value ?? "discard";
  if (policy !== "discard") {
    throw new ApiError(
      ERROR_CODES.INVALID_BOUNDARY_POLICY,
      "boundaryPolicy 目前只支持 discard",
    );
  }
  return policy;
}

export function validateTraceBudget(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApiError(ERROR_CODES.INVALID_LIMIT, "traceBudget 必须是非负整数");
  }
  return value;
}
