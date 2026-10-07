import { AppError } from './errors.js';

export interface Limits {
  maxWidth: number;
  maxHeight: number;
  maxCells: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxWidth: 4096,
  maxHeight: 4096,
  maxCells: 262144,
};

export interface ValidatedMatrix {
  matrix: number[][];
  width: number;
  height: number;
}

/**
 * 校验并深拷贝输入矩阵。
 * 仅接受：非空、矩形、所有元素为 0..255 的整数（不接受小数、NaN、字符串等）。
 */
export function validateMatrix(input: unknown, limits: Limits = DEFAULT_LIMITS): ValidatedMatrix {
  if (!isArrayArray(input)) {
    if (Array.isArray(input) && input.length === 0) {
      throw new AppError('EMPTY_MATRIX', '矩阵不能为空：至少需要一行。', 400);
    }
    throw new AppError('INVALID_PARAM', 'matrix 必须是二维整数数组（行的数组）。', 400);
  }

  const rows = input as unknown[][];
  if (rows.length === 0) {
    throw new AppError('EMPTY_MATRIX', '矩阵不能为空：至少需要一行。', 400);
  }
  if (rows.length > limits.maxHeight) {
    throw new AppError(
      'INVALID_DIMENSIONS',
      `高度 ${rows.length} 超过上限 ${limits.maxHeight}。`,
      422,
    );
  }

  const width = (rows[0] as unknown[]).length;
  if (width === 0) {
    throw new AppError('EMPTY_ROW', '第 0 行为空：每一行至少包含一个像素。', 422);
  }
  if (width > limits.maxWidth) {
    throw new AppError(
      'INVALID_DIMENSIONS',
      `宽度 ${width} 超过上限 ${limits.maxWidth}。`,
      422,
    );
  }
  if (rows.length * width > limits.maxCells) {
    throw new AppError(
      'INVALID_DIMENSIONS',
      `像素总数 ${rows.length * width} 超过上限 ${limits.maxCells}。`,
      422,
    );
  }

  const matrix: number[][] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as unknown;
    if (!Array.isArray(row)) {
      throw new AppError('INVALID_PARAM', `第 ${r} 行不是数组。`, 400);
    }
    if (row.length === 0) {
      throw new AppError('EMPTY_ROW', `第 ${r} 行为空：不允许空行。`, 422);
    }
    if (row.length !== width) {
      throw new AppError(
        'NOT_RECTANGULAR',
        `矩阵不是矩形：第 0 行宽 ${width}，第 ${r} 行宽 ${row.length}。`,
        422,
      );
    }
    const outRow: number[] = new Array<number>(width);
    for (let c = 0; c < width; c++) {
      const v = row[c] as unknown;
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
        throw new AppError(
          'INVALID_VALUE',
          `位置 (${r},${c}) 的值 ${safeStringify(v)} 不是整数。仅接受 0..255 的整数，不接受小数或非数值。`,
          422,
        );
      }
      if (v < 0 || v > 255) {
        throw new AppError(
          'INVALID_VALUE',
          `位置 (${r},${c}) 的值 ${v} 超出范围，仅接受 0..255 的整数。`,
          422,
        );
      }
      outRow[c] = v;
    }
    matrix.push(outRow);
  }

  return { matrix, width, height: rows.length };
}

function isArrayArray(v: unknown): v is unknown[][] {
  return Array.isArray(v) && v.every((row) => Array.isArray(row));
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const VALID_MODES = ['lr', 'serpentine'] as const;
export type ScanMode = (typeof VALID_MODES)[number];
export const VALID_BOUNDARIES = ['discard'] as const;
export type BoundaryPolicy = (typeof VALID_BOUNDARIES)[number];

export function parseMode(input: unknown): ScanMode {
  if (input === undefined || input === null) return 'lr';
  if (typeof input !== 'string' || !(VALID_MODES as readonly string[]).includes(input)) {
    throw new AppError(
      'INVALID_MODE',
      `未知扫描模式 ${safeStringify(input)}：仅支持 'lr'（普通从左向右）或 'serpentine'（蛇形）。`,
      400,
    );
  }
  return input as ScanMode;
}

export function parseBoundary(input: unknown): BoundaryPolicy {
  if (input === undefined || input === null) return 'discard';
  if (input !== 'discard') {
    throw new AppError(
      'INVALID_BOUNDARY',
      `未知边界策略 ${safeStringify(input)}：当前仅支持 'discard'（超出边界直接丢弃，不归一化、不绕回）。`,
      400,
    );
  }
  return 'discard';
}
