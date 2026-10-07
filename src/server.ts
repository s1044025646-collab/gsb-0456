import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { ApiError } from "./errors.js";
import { toAsciiPGM, toBinaryPGM } from "./pgm.js";
import { DitherStore } from "./store.js";
import {
  validateBoundaryPolicy,
  validateMatrix,
  validateMode,
  validateTraceBudget,
} from "./validation.js";
import { compareResults, getPixel, recomputeSummaryCheck, traceSteps } from "./service.js";

export interface AppContext {
  store: DitherStore;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError("INVALID_JSON", "请求体不是合法 JSON", 400);
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function routePath(pathname: string): { name: string; params: string[] } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "health") return { name: "health", params: [] };
  if (parts.length === 1 && parts[0] === "datasets") return { name: "datasets", params: [] };
  if (parts.length === 2 && parts[0] === "datasets") return { name: "dataset", params: [parts[1]!] };
  if (parts.length === 3 && parts[0] === "datasets" && parts[2] === "reports") {
    return { name: "datasetReports", params: [parts[1]!] };
  }
  if (parts.length === 3 && parts[0] === "datasets" && parts[2] === "compare") {
    return { name: "compareModes", params: [parts[1]!] };
  }
  if (parts.length === 2 && parts[0] === "reports") return { name: "report", params: [parts[1]!] };
  if (parts.length === 3 && parts[0] === "reports" && parts[2] === "pixels") {
    return { name: "reportPixel", params: [parts[1]!] };
  }
  if (parts.length === 3 && parts[0] === "reports" && parts[2] === "trace") {
    return { name: "reportTrace", params: [parts[1]!] };
  }
  if (parts.length === 3 && parts[0] === "reports" && parts[2] === "export") {
    return { name: "reportExport", params: [parts[1]!] };
  }
  if (parts.length === 2 && parts[0] === "reports" && parts[1] === "compare") {
    return { name: "compareReports", params: [] };
  }
  return { name: "notFound", params: [] };
}

export function createApp(context: AppContext): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = routePath(url.pathname);

      if (route.name === "health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && route.name === "datasets") {
        const body = asObject(await readJson(req));
        const matrix = validateMatrix(body.matrix);
        const dataset = context.store.importMatrix(matrix);
        sendJson(res, 200, dataset);
        return;
      }

      if (req.method === "GET" && route.name === "dataset") {
        sendJson(res, 200, context.store.getDatasetOrThrow(route.params[0]!));
        return;
      }

      if (req.method === "POST" && route.name === "datasetReports") {
        const body = asObject(await readJson(req));
        validateBoundaryPolicy(body.boundaryPolicy);
        const mode = validateMode(body.mode);
        const traceBudget = validateTraceBudget(body.traceBudget);
        const { report, created } = context.store.createReport(
          route.params[0]!,
          mode,
          traceBudget,
        );
        sendJson(res, created ? 201 : 200, { created, ...report });
        return;
      }

      if (req.method === "GET" && route.name === "datasetReports") {
        const datasetId = route.params[0]!;
        context.store.getDatasetOrThrow(datasetId);
        sendJson(res, 200, context.store.listReports(datasetId));
        return;
      }

      if (req.method === "POST" && route.name === "compareModes") {
        const body = asObject(await readJson(req));
        const firstMode = validateMode(body.firstMode);
        const secondMode = validateMode(body.secondMode);
        const datasetId = route.params[0]!;
        const first = context.store.createReport(datasetId, firstMode).report;
        const second = context.store.createReport(datasetId, secondMode).report;
        sendJson(res, 200, {
          firstReportId: first.id,
          secondReportId: second.id,
          comparison: compareResults(first.result, second.result),
        });
        return;
      }

      if (req.method === "GET" && route.name === "report") {
        const report = context.store.getReportOrThrow(route.params[0]!);
        const verify = url.searchParams.get("verify");
        if (verify === "1" || verify === "true") {
          const dataset = context.store.getDatasetOrThrow(report.datasetId);
          sendJson(res, 200, { ...report, recomputeCheck: recomputeSummaryCheck(dataset.matrix, report.result) });
          return;
        }
        sendJson(res, 200, report);
        return;
      }

      if (req.method === "GET" && route.name === "reportPixel") {
        const report = context.store.getReportOrThrow(route.params[0]!);
        const row = Number(url.searchParams.get("row"));
        const col = Number(url.searchParams.get("col"));
        sendJson(res, 200, getPixel(report.result, row, col));
        return;
      }

      if (req.method === "GET" && route.name === "reportTrace") {
        const report = context.store.getReportOrThrow(route.params[0]!);
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? undefined : Number(rawLimit);
        sendJson(res, 200, traceSteps(report.result, limit));
        return;
      }

      if (req.method === "GET" && route.name === "reportExport") {
        const report = context.store.getReportOrThrow(route.params[0]!);
        const format = url.searchParams.get("format") ?? "json";
        if (format === "json") {
          sendJson(res, 200, {
            datasetId: report.datasetId,
            reportId: report.id,
            mode: report.mode,
            boundaryPolicy: report.boundaryPolicy,
            ruleVersion: report.ruleVersion,
            output: report.result.output,
            summary: report.result.summary,
          });
          return;
        }
        if (format === "pgm") {
          const binary = toBinaryPGM(report.result.output);
          res.writeHead(200, {
            "content-type": "image/x-portable-graymap",
            "content-disposition": `attachment; filename="${report.id}.pgm"`,
            "content-length": binary.length,
          });
          res.end(binary);
          return;
        }
        if (format === "pgm-ascii") {
          const body = toAsciiPGM(report.result.output);
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-length": Buffer.byteLength(body),
          });
          res.end(body);
          return;
        }
        throw new ApiError("INVALID_FORMAT", "format 必须是 json、pgm 或 pgm-ascii");
      }

      if (req.method === "POST" && route.name === "compareReports") {
        const body = asObject(await readJson(req));
        const first = context.store.getReportOrThrow(String(body.firstReportId));
        const second = context.store.getReportOrThrow(String(body.secondReportId));
        sendJson(res, 200, {
          firstReportId: first.id,
          secondReportId: second.id,
          comparison: compareResults(first.result, second.result),
        });
        return;
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "未找到 API 路由" } });
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      } else {
        const message = error instanceof Error ? error.message : "未知错误";
        sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message } });
      }
    }
  });
}

export function chooseIdlePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("无法选择空闲端口"));
      });
    });
  });
}

async function main(): Promise<void> {
  const configuredPort = Number(process.env.PORT ?? "");
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : await chooseIdlePort();
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  const store = new DitherStore(join(dataDir, "floyd.sqlite"));
  const server = createApp({ store });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Floyd–Steinberg API listening on http://127.0.0.1:${port}`);
    console.log(`SQLite data file: ${join(dataDir, "floyd.sqlite")}`);
  });
}

if (process.argv[1] && new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href === import.meta.url) {
  void main();
}
