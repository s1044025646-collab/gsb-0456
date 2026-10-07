import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DitherResult } from './dither.js';
import type { BoundaryPolicy, ScanMode } from './validation.js';

export interface DatasetRow {
  id: string;
  width: number;
  height: number;
  cell_count: number;
  matrix_json: string;
  matrix_hash: string;
  created_at: string;
}

export interface ReportRow {
  id: string;
  dataset_id: string;
  mode: string;
  boundary: string;
  rule_version: string;
  output_json: string;
  pixels_json: string;
  summary_json: string;
  created_at: string;
}

type Stmt = ReturnType<DatabaseSync['prepare']>;

export class Store {
  readonly db: DatabaseSync;
  private readonly insDataset: Stmt;
  private readonly getDatasetByHash: Stmt;
  private readonly getDataset: Stmt;
  private readonly listDatasets: Stmt;
  private readonly insReport: Stmt;
  private readonly getReportKey: Stmt;
  private readonly getReport: Stmt;
  private readonly listReports: Stmt;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        cell_count INTEGER NOT NULL,
        matrix_json TEXT NOT NULL,
        matrix_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id),
        mode TEXT NOT NULL,
        boundary TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        output_json TEXT NOT NULL,
        pixels_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(dataset_id, mode, boundary, rule_version)
      );
    `);

    this.insDataset = this.db.prepare(
      'INSERT INTO datasets (id, width, height, cell_count, matrix_json, matrix_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    );
    this.getDatasetByHash = this.db.prepare('SELECT * FROM datasets WHERE matrix_hash = ?');
    this.getDataset = this.db.prepare('SELECT * FROM datasets WHERE id = ?');
    this.listDatasets = this.db.prepare('SELECT id, width, height, cell_count, created_at FROM datasets ORDER BY created_at');
    this.insReport = this.db.prepare(
      'INSERT INTO reports (id, dataset_id, mode, boundary, rule_version, output_json, pixels_json, summary_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    this.getReportKey = this.db.prepare(
      'SELECT * FROM reports WHERE dataset_id = ? AND mode = ? AND boundary = ? AND rule_version = ?',
    );
    this.getReport = this.db.prepare('SELECT * FROM reports WHERE id = ?');
    this.listReports = this.db.prepare(
      'SELECT id, dataset_id, mode, boundary, rule_version, created_at FROM reports ORDER BY created_at',
    );
  }

  /** 幂等导入：相同矩阵返回既有数据集（duplicated=true），不产生半成功数据。 */
  importDataset(args: {
    id: string;
    width: number;
    height: number;
    matrixJson: string;
    hash: string;
  }): { row: DatasetRow; duplicated: boolean } {
    const existing = this.getDatasetByHash.get(args.hash) as DatasetRow | undefined;
    if (existing) return { row: existing, duplicated: true };
    this.insDataset.run(
      args.id,
      args.width,
      args.height,
      args.width * args.height,
      args.matrixJson,
      args.hash,
      new Date().toISOString(),
    );
    return {
      row: this.getDatasetByHash.get(args.hash) as unknown as DatasetRow,
      duplicated: false,
    };
  }

  getDatasetById(id: string): DatasetRow | undefined {
    return this.getDataset.get(id) as unknown as DatasetRow | undefined;
  }

  listDatasetMeta(): unknown[] {
    return this.listDatasets.all() as unknown[];
  }

  /** 幂等执行：同一数据集+模式+边界+规则版本返回旧报告，旧结果不重算覆盖。 */
  saveReportIfAbsent(args: {
    id: string;
    datasetId: string;
    result: DitherResult;
  }): { row: ReportRow; duplicated: boolean } {
    const { result } = args;
    const existing = this.getReportKey.get(
      args.datasetId,
      result.mode,
      result.boundary,
      result.ruleVersion,
    ) as ReportRow | undefined;
    if (existing) return { row: existing, duplicated: true };
    this.insReport.run(
      args.id,
      args.datasetId,
      result.mode,
      result.boundary,
      result.ruleVersion,
      JSON.stringify(result.output),
      JSON.stringify(result.pixels),
      JSON.stringify(result.summary),
      new Date().toISOString(),
    );
    return {
      row: this.getReportKey.get(
        args.datasetId,
        result.mode,
        result.boundary,
        result.ruleVersion,
      ) as unknown as ReportRow,
      duplicated: false,
    };
  }

  getReportById(id: string): ReportRow | undefined {
    return this.getReport.get(id) as unknown as ReportRow | undefined;
  }

  listReportMeta(): unknown[] {
    return this.listReports.all() as unknown[];
  }

  close(): void {
    this.db.close();
  }
}

export function parseMode(m: string): ScanMode {
  return m as ScanMode;
}

export function parseBoundary(b: string): BoundaryPolicy {
  return b as BoundaryPolicy;
}
