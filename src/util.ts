import { createHash, randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/** 对矩阵做稳定哈希：相同矩阵（逐元素相等）得到相同 ID 键。 */
export function hashMatrix(matrix: number[][]): string {
  return createHash('sha256').update(JSON.stringify(matrix)).digest('hex');
}
