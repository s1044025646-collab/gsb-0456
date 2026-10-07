import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AppError, type ErrorCode } from './errors.js';
import { DitherService } from './service.js';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

interface Route {
  method: string;
  pattern: RegExp;
  handler: (svc: DitherService, body: unknown, query: URLSearchParams, groups: RegExpMatchArray) => unknown;
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/health$/, handler: () => ({ status: 'ok' }) },
  { method: 'POST', pattern: /^\/datasets$/, handler: (svc, body) => svc.importMatrix(body) },
  { method: 'GET', pattern: /^\/datasets$/, handler: (svc) => svc.listDatasets() },
  {
    method: 'GET',
    pattern: /^\/datasets\/([^/]+)$/,
    handler: (svc, _b, _q, g) => svc.getDataset(g[1]!),
  },
  {
    method: 'POST',
    pattern: /^\/datasets\/([^/]+)\/reports$/,
    handler: (svc, body, _q, g) => {
      const b = (body ?? {}) as Record<string, unknown>;
      return svc.runReport(g[1]!, b.mode, b.boundary);
    },
  },
  {
    method: 'GET',
    pattern: /^\/datasets\/([^/]+)\/compare$/,
    handler: (svc, _b, _q, g) => svc.compare(g[1]!),
  },
  { method: 'GET', pattern: /^\/reports$/, handler: (svc) => svc.listReports() },
  {
    method: 'GET',
    pattern: /^\/reports\/([^/]+)$/,
    handler: (svc, _b, q, g) => svc.getReport(g[1]!, q.get('budget')),
  },
  {
    method: 'GET',
    pattern: /^\/reports\/([^/]+)\/steps$/,
    handler: (svc, _b, q, g) => svc.getSteps(g[1]!, q.get('budget')),
  },
  {
    method: 'GET',
    pattern: /^\/reports\/([^/]+)\/pixels\/(-?\d+),(-?\d+)$/,
    handler: (svc, _b, _q, g) => svc.getPixel(g[1]!, g[2], g[3]),
  },
  {
    method: 'GET',
    pattern: /^\/reports\/([^/]+)\/export$/,
    handler: (svc, _b, q, g) => svc.exportMatrix(g[1]!, q.get('layer')),
  },
  {
    method: 'POST',
    pattern: /^\/reports\/([^/]+)\/verify$/,
    handler: (svc, _b, _q, g) => svc.verifyReport(g[1]!),
  },
];

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(
    payload instanceof Error
      ? {
          error: {
            code: (payload as AppError).code ?? 'INTERNAL',
            message: payload.message,
          },
        }
      : payload,
  );
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError('BODY_TOO_LARGE', `请求体超过 ${MAX_BODY_BYTES} 字节上限。`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new AppError('BAD_JSON', '请求体不是合法 JSON。', 400));
      }
    });
    req.on('error', () => reject(new AppError('BAD_JSON', '读取请求体失败。', 400)));
  });
}

export function startServer(svc: DitherService, port: number): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    void handle(req, res, svc);
  });
  return new Promise((resolve) => {
    // port 0 时由操作系统选择空闲端口。
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: actual });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, svc: DitherService): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
    if (!route) {
      sendJson(res, 404, {
        error: { code: 'NOT_FOUND' satisfies ErrorCode, message: `没有与 ${method} ${url.pathname} 匹配的路由。` },
      });
      return;
    }
    const body = method === 'POST' ? await readBody(req) : {};
    const groups = url.pathname.match(route.pattern)!;
    const result = await route.handler(svc, body, url.searchParams, groups);

    if (
      result &&
      typeof result === 'object' &&
      'body' in result &&
      'media' in result &&
      Buffer.isBuffer((result as { body: unknown }).body)
    ) {
      const file = result as { filename: string; media: string; body: Buffer };
      res.writeHead(200, {
        'content-type': file.media,
        'content-disposition': `attachment; filename="${file.filename}"`,
      });
      res.end(file.body);
      return;
    }
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof AppError) {
      sendJson(res, error.status, error);
    } else {
      sendJson(res, 500, new AppError('INTERNAL', (error as Error).message, 500));
    }
  }
}
