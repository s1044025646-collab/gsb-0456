import { AppError } from './errors.js';
import { Store, type DatasetRow, type ReportRow } from './db.js';
import {
  CONSERVATION_TOLERANCE_PER_CELL,
  dither,
  fixedThreshold,
  RULE_VERSION,
  toPGM,
  type DitherResult,
  type PixelRecord,
} from './dither.js';
import {
  DEFAULT_LIMITS,
  parseBoundary,
  parseMode,
  validateMatrix,
  type Limits,
} from './validation.js';
import { hashMatrix, newId } from './util.js';

export interface Truncation {
  requestedBudget: number | null;
  shownRecords: number;
  totalRecords: number;
  truncated: boolean;
  explanation: string;
}

export interface ReportView {
  id: string;
  datasetId: string;
  ruleVersion: string;
  mode: string;
  boundary: string;
  output: number[][];
  summary: DitherResult['summary'];
  pixels: PixelRecord[];
  truncation: Truncation;
  /** 正式计算是否完整：始终为 true。预算只影响展示记录数，不少处理任何像素。 */
  officialComputationComplete: true;
  createdAt: string;
}

const MAX_SAFE_BUDGET = Number.MAX_SAFE_INTEGER;

export class DitherService {
  constructor(
    private readonly store: Store,
    readonly limits: Limits = DEFAULT_LIMITS,
  ) {}

  importMatrix(raw: unknown): { id: string; duplicated: boolean; width: number; height: number } {
    const { matrix, width, height } = validateMatrix(raw, this.limits);
    const hash = hashMatrix(matrix);
    const { row, duplicated } = this.store.importDataset({
      id: newId('ds'),
      width,
      height,
      matrixJson: JSON.stringify(matrix),
      hash,
    });
    return { id: row.id, duplicated, width, height };
  }

  getDataset(id: string): { id: string; width: number; height: number; matrix: number[][] } {
    const row = this.requireDataset(id);
    return {
      id: row.id,
      width: row.width,
      height: row.height,
      matrix: JSON.parse(row.matrix_json) as number[][],
    };
  }

  listDatasets(): unknown {
    return this.store.listDatasetMeta();
  }

  runReport(datasetId: string, rawMode: unknown, rawBoundary: unknown): {
    id: string;
    duplicated: boolean;
  } {
    const ds = this.requireDataset(datasetId);
    const mode = parseMode(rawMode);
    const boundary = parseBoundary(rawBoundary);
    const matrix = JSON.parse(ds.matrix_json) as number[][];
    const result = dither(matrix, { mode, boundary });
    const { row, duplicated } = this.store.saveReportIfAbsent({
      id: newId('rp'),
      datasetId: ds.id,
      result,
    });
    return { id: row.id, duplicated };
  }

  getReport(id: string, budget?: unknown): ReportView {
    const row = this.requireReport(id);
    return this.toView(row, this.parseBudget(budget));
  }

  listReports(): unknown {
    return this.store.listReportMeta();
  }

  /** 单个像素的完整来源信息；读取不改变任何算法状态。 */
  getPixel(
    reportId: string,
    rawRow: unknown,
    rawCol: unknown,
  ): PixelRecord & { reportId: string; scanIndex: number } {
    const row = this.requireReport(reportId);
    const r = this.parseCoord(rawRow, 'row');
    const c = this.parseCoord(rawCol, 'col');
    const pixels = JSON.parse(row.pixels_json) as PixelRecord[];
    const width = this.readSummary(row).width;
    if (r < 0 || c < 0 || r >= this.readSummary(row).height || c >= width) {
      throw new AppError(
        'INVALID_PARAM',
        `坐标 (${r},${c}) 超出报告尺寸 ${this.readSummary(row).height}x${width}。`,
        400,
      );
    }
    const rec = pixels[r * width + c]!;
    return { ...rec, reportId, scanIndex: rec.order };
  }

  /** 有限传播步骤：按扫描顺序返回前 budget 个像素的完整记录。 */
  getSteps(reportId: string, budget?: unknown): {
    reportId: string;
    steps: PixelRecord[];
    truncation: Truncation;
    officialComputationComplete: true;
  } {
    const row = this.requireReport(reportId);
    const b = this.parseBudget(budget);
    const pixels = JSON.parse(row.pixels_json) as PixelRecord[];
    return {
      reportId,
      steps: pixels.slice(0, b),
      truncation: this.buildTruncation(pixels.length, b),
      officialComputationComplete: true,
    };
  }

  exportMatrix(reportId: string, layer: unknown): { filename: string; media: string; body: Buffer } {
    const row = this.requireReport(reportId);
    const ds = this.requireDataset(row.dataset_id);
    const which = layer === undefined || layer === null ? 'output' : String(layer);
    if (which === 'pgm' || which === 'output') {
      const output = JSON.parse(row.output_json) as number[][];
      return {
        filename: `${reportId}.pgm`,
        media: 'image/x-portable-graymap',
        body: toPGM(output),
      };
    }
    if (which === 'output.json' || which === 'json') {
      return {
        filename: `${reportId}.output.json`,
        media: 'application/json',
        body: Buffer.from(row.output_json),
      };
    }
    if (which === 'original' || which === 'original.json') {
      return {
        filename: `${row.dataset_id}.original.json`,
        media: 'application/json',
        body: Buffer.from(ds.matrix_json),
      };
    }
    throw new AppError(
      'INVALID_PARAM',
      `不支持的导出类型 ${which}：可选 output(pgm)/json/original。`,
      400,
    );
  }

  /**
   * 比较同一数据集上：固定阈值 / 普通扩散 / 蛇形扩散。
   * 不落库，不改变既有报告。
   */
  compare(datasetId: string): {
    datasetId: string;
    ruleVersion: string;
    tolerancePerCell: number;
    fixedThreshold: DitherResult['summary'] & { output: number[][] };
    lr: DitherResult['summary'] & { output: number[][] };
    serpentine: DitherResult['summary'] & { output: number[][] };
    note: string;
  } {
    const ds = this.requireDataset(datasetId);
    const matrix = JSON.parse(ds.matrix_json) as number[][];
    const ft = fixedThreshold(matrix);
    const lr = dither(matrix, { mode: 'lr', boundary: 'discard' });
    const sp = dither(matrix, { mode: 'serpentine', boundary: 'discard' });
    const ftView = { ...ft.summary, output: ft.output };
    return {
      datasetId,
      ruleVersion: RULE_VERSION,
      tolerancePerCell: CONSERVATION_TOLERANCE_PER_CELL,
      fixedThreshold: ftView,
      lr: { ...lr.summary, output: lr.output },
      serpentine: { ...sp.summary, output: sp.output },
      note: '固定阈值不扩散、不做误差账目；扩散结果在公开浮点容差内核验 conservationVerified。平均亮度不保证完全守恒。',
    };
  }

  /** 从冻结原图重算并与已保存报告核对（重启后可用）。 */
  verifyReport(reportId: string): {
    reportId: string;
    recomputed: boolean;
    outputMatches: boolean;
    summaryConservationVerified: boolean;
  } {
    const row = this.requireReport(reportId);
    const ds = this.requireDataset(row.dataset_id);
    const matrix = JSON.parse(ds.matrix_json) as number[][];
    const result = dither(matrix, {
      mode: row.mode as DitherResult['mode'],
      boundary: row.boundary as DitherResult['boundary'],
    });
    return {
      reportId,
      recomputed: true,
      outputMatches: JSON.stringify(result.output) === row.output_json,
      summaryConservationVerified: result.summary.conservationVerified,
    };
  }

  private toView(row: ReportRow, budget: number): ReportView {
    const pixels = JSON.parse(row.pixels_json) as PixelRecord[];
    return {
      id: row.id,
      datasetId: row.dataset_id,
      ruleVersion: row.rule_version,
      mode: row.mode,
      boundary: row.boundary,
      output: JSON.parse(row.output_json) as number[][],
      summary: this.readSummary(row),
      pixels: pixels.slice(0, budget),
      truncation: this.buildTruncation(pixels.length, budget),
      officialComputationComplete: true,
      createdAt: row.created_at,
    };
  }

  private buildTruncation(total: number, budget: number): Truncation {
    const shown = Math.min(total, budget);
    const truncated = shown < total;
    return {
      requestedBudget: budget >= MAX_SAFE_BUDGET ? null : budget,
      shownRecords: shown,
      totalRecords: total,
      truncated,
      explanation: truncated
        ? `展示预算为 ${budget} 条，共 ${total} 个像素，已截断其余 ${total - shown} 条详细传播记录。截断仅影响展示，正式扩散计算始终对全部 ${total} 个像素完整完成（officialComputationComplete=true），输出与汇总不受预算影响。`
        : `已展示全部 ${total} 条像素传播记录。正式计算对全部像素完整完成。`,
    };
  }

  private parseBudget(raw: unknown): number {
    if (raw === undefined || raw === null || raw === '') return MAX_SAFE_BUDGET;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new AppError(
        'INVALID_PARAM',
        `budget 必须是正整数，收到 ${String(raw)}。`,
        400,
      );
    }
    return n;
  }

  private parseCoord(raw: unknown, name: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new AppError('INVALID_PARAM', `${name} 必须是非负整数，收到 ${String(raw)}。`, 400);
    }
    return n;
  }

  private readSummary(row: ReportRow): DitherResult['summary'] {
    return JSON.parse(row.summary_json) as DitherResult['summary'];
  }

  private requireDataset(id: string): DatasetRow {
    const row = this.store.getDatasetById(id);
    if (!row) throw new AppError('NOT_FOUND', `数据集 ${id} 不存在。`, 404);
    return row;
  }

  private requireReport(id: string): ReportRow {
    const row = this.store.getReportById(id);
    if (!row) throw new AppError('NOT_FOUND', `报告 ${id} 不存在。`, 404);
    return row;
  }
}
