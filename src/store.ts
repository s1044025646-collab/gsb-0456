import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ApiError, ERROR_CODES } from "./errors.js";
import { RULE_VERSION, runDithering } from "./dither.js";
import type { DitherResult, ScanMode } from "./types.js";

export interface DatasetRecord {
  id: string;
  width: number;
  height: number;
  matrix: number[][];
  createdAt: string;
}

export interface ReportRecord {
  id: string;
  datasetId: string;
  mode: ScanMode;
  boundaryPolicy: "discard";
  ruleVersion: string;
  traceBudget: number | null;
  result: DitherResult;
  createdAt: string;
}

export function stableId(prefix: string, canonical: string): string {
  return `${prefix}_${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

export class DitherStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        matrix_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id),
        mode TEXT NOT NULL,
        boundary_policy TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        trace_budget INTEGER,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(dataset_id, mode, boundary_policy, rule_version, trace_budget)
      );
    `);
  }

  importMatrix(matrix: number[][]): DatasetRecord {
    const width = matrix[0]?.length ?? 0;
    const height = matrix.length;
    const canonical = JSON.stringify(matrix);
    const id = stableId("ds", canonical);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO datasets (id, width, height, matrix_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, width, height, canonical);
    return this.getDatasetOrThrow(id);
  }

  getDatasetOrThrow(id: string): DatasetRecord {
    const row = this.db
      .prepare(
        `SELECT id, width, height, matrix_json AS matrixJson, created_at AS createdAt
         FROM datasets WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          width: number;
          height: number;
          matrixJson: string;
          createdAt: string;
        }
      | undefined;
    if (!row) throw new ApiError(ERROR_CODES.NOT_FOUND, `数据集不存在: ${id}`, 404);
    return {
      id: row.id,
      width: row.width,
      height: row.height,
      matrix: JSON.parse(row.matrixJson) as number[][],
      createdAt: row.createdAt,
    };
  }

  createReport(
    datasetId: string,
    mode: ScanMode,
    traceBudget: number | null = null,
  ): { report: ReportRecord; created: boolean } {
    const dataset = this.getDatasetOrThrow(datasetId);
    const id = stableId(
      "rpt",
      JSON.stringify([dataset.id, mode, "discard", RULE_VERSION, traceBudget]),
    );
    const existing = this.findReport(id);
    if (existing) return { report: existing, created: false };

    const result = runDithering(dataset.matrix, mode, traceBudget);
    this.db
      .prepare(
        `INSERT INTO reports (
           id, dataset_id, mode, boundary_policy, rule_version, trace_budget, result_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        dataset.id,
        mode,
        "discard",
        RULE_VERSION,
        traceBudget,
        JSON.stringify(result),
      );
    return { report: this.getReportOrThrow(id), created: true };
  }

  private findReport(id: string): ReportRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, dataset_id AS datasetId, mode, boundary_policy AS boundaryPolicy,
                rule_version AS ruleVersion, trace_budget AS traceBudget,
                result_json AS resultJson, created_at AS createdAt
         FROM reports WHERE id = ?`,
      )
      .get(id) as ReportRow | undefined;
    return row ? this.hydrateReport(row) : null;
  }

  getReportOrThrow(id: string): ReportRecord {
    const found = this.findReport(id);
    if (!found) throw new ApiError(ERROR_CODES.NOT_FOUND, `报告不存在: ${id}`, 404);
    return found;
  }

  listReports(datasetId: string): ReportRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, dataset_id AS datasetId, mode, boundary_policy AS boundaryPolicy,
                rule_version AS ruleVersion, trace_budget AS traceBudget,
                result_json AS resultJson, created_at AS createdAt
         FROM reports WHERE dataset_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(datasetId) as unknown as ReportRow[];
    return rows.map((row) => this.hydrateReport(row));
  }

  private hydrateReport(row: ReportRow): ReportRecord {
    return {
      id: row.id,
      datasetId: row.datasetId,
      mode: row.mode as ScanMode,
      boundaryPolicy: row.boundaryPolicy as "discard",
      ruleVersion: row.ruleVersion,
      traceBudget: row.traceBudget,
      result: JSON.parse(row.resultJson) as DitherResult,
      createdAt: row.createdAt,
    };
  }

  close(): void {
    this.db.close();
  }
}

interface ReportRow {
  id: string;
  datasetId: string;
  mode: string;
  boundaryPolicy: string;
  ruleVersion: string;
  traceBudget: number | null;
  resultJson: string;
  createdAt: string;
}
