/**
 * @file csv-controller.test.ts
 * @description
 * csv-controller.ts に含まれる Controller のユニットテスト。
 *
 * テスト戦略:
 *  - ICsvIoService と ILogger をモック化することで、
 *    Controller の責務（バリデーション・レスポンス構築）のみを検証する。
 *  - KoaContext の最小モックを手作りし、Koa/Strapi への依存をゼロにする。
 *
 * テスト対象の振る舞い:
 *  - import: 正常系・バリデーションエラー・サービスエラー
 *  - export: 正常系・バリデーションエラー・サービスエラー
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import csvControllerFactory from './csv-controller';
import type { ICsvIoService, ILogger, ImportResult, ExportResult } from '../interfaces/data-processor';

// ---------------------------------------------------------------------------
// KoaContext モック
// ---------------------------------------------------------------------------

interface MockResponse {
  body: unknown;
  status: number;
  headers: Record<string, string>;
}

interface MockContext {
  request: {
    body: Record<string, unknown>;
    files?: Record<string, unknown>;
  };
  query: Record<string, string>;
  params: Record<string, string>;
  response: MockResponse;
  /** badRequest 呼び出しを記録するためのスパイ */
  badRequest: ReturnType<typeof vi.fn>;
  /** throw 呼び出しを記録するためのスパイ */
  throw: ReturnType<typeof vi.fn>;
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  const response: MockResponse = { body: undefined, status: 200, headers: {} };

  return {
    request: { body: {} },
    query: {},
    params: {},
    response: {
      ...response,
      set(key: string, value: string) {
        this.headers[key] = value;
      },
      attachment(filename: string) {
        this.headers['Content-Disposition'] = `attachment; filename="${filename}"`;
      },
    },
    badRequest: vi.fn().mockImplementation((msg, details) => {
      throw Object.assign(new Error(msg), { status: 400, details });
    }),
    throw: vi.fn().mockImplementation((status, msg) => {
      throw Object.assign(new Error(msg ?? 'Error'), { status });
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 一時ファイル生成ヘルパー（Strapi の formidable がディスクに書き込む挙動を模倣）
// ---------------------------------------------------------------------------

function createTempCsvFile(content: string): { filepath: string; cleanup: () => void } {
  const filepath = path.join(os.tmpdir(), `test-${Date.now()}.csv`);
  fs.writeFileSync(filepath, content, 'utf-8');
  return {
    filepath,
    cleanup: () => {
      try { fs.unlinkSync(filepath); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// モック生成ヘルパー
// ---------------------------------------------------------------------------

const SUCCESS_IMPORT_RESULT: ImportResult = {
  created: 2,
  updated: 0,
  skipped: 0,
  failed: 0,
  errors: [],
};

const PARTIAL_IMPORT_RESULT: ImportResult = {
  created: 1,
  updated: 0,
  skipped: 0,
  failed: 1,
  errors: [{ row: 1, message: 'Invalid value' }],
};

const SUCCESS_EXPORT_RESULT: ExportResult = {
  data: 'title,slug\nHello,hello',
  mimeType: 'text/csv; charset=utf-8',
  filename: 'export_api__article_article_2024-01-01.csv',
};

function createMockService(
  overrides: Partial<ICsvIoService> = {}
): ICsvIoService {
  return {
    importCsv: vi.fn().mockResolvedValue(SUCCESS_IMPORT_RESULT),
    exportCsv: vi.fn().mockResolvedValue(SUCCESS_EXPORT_RESULT),
    ...overrides,
  };
}

function createMockLogger(): ILogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
}

/** csvControllerFactory が期待する Strapi オブジェクトのスタブ */
function createFakeStrapi(service: ICsvIoService, logger: ILogger) {
  return {
    plugin: (_name: string) => ({
      service: (_svc: string) => service,
    }),
    log: logger,
  };
}

// ---------------------------------------------------------------------------
// import エンドポイントのテスト
// ---------------------------------------------------------------------------

describe('csvController.import', () => {
  let service: ICsvIoService;
  let logger: ILogger;
  let controller: { import: (ctx: unknown) => Promise<void>; export: (ctx: unknown) => Promise<void> };
  let tempFile: ReturnType<typeof createTempCsvFile>;

  beforeEach(() => {
    service = createMockService();
    logger = createMockLogger();
    controller = csvControllerFactory({ strapi: createFakeStrapi(service, logger) });
    tempFile = createTempCsvFile('title,slug\nHello,hello');
  });

  afterEach(() => {
    tempFile.cleanup();
  });

  it('正常なリクエストで 200 と ImportResult を返す', async () => {
    const ctx = createMockContext({
      query: { contentType: 'api::article.article' },
      request: {
        body: {},
        files: {
          files: {
            filepath: tempFile.filepath,
            mimetype: 'text/csv',
            size: 100,
          },
        },
      },
    });

    await controller.import(ctx);

    expect(ctx.response.status).toBe(200);
    expect(ctx.response.body).toMatchObject({
      data: { created: 2, updated: 0, failed: 0 },
    });
  });

  it('一部失敗がある場合は 207 Multi-Status を返す', async () => {
    service = createMockService({ importCsv: vi.fn().mockResolvedValue(PARTIAL_IMPORT_RESULT) });
    controller = csvControllerFactory({ strapi: createFakeStrapi(service, logger) });

    const ctx = createMockContext({
      query: { contentType: 'api::article.article' },
      request: {
        body: {},
        files: {
          files: {
            filepath: tempFile.filepath,
            mimetype: 'text/csv',
            size: 100,
          },
        },
      },
    });

    await controller.import(ctx);

    expect(ctx.response.status).toBe(207);
    expect(ctx.response.body).toMatchObject({ errors: PARTIAL_IMPORT_RESULT.errors });
  });

  it('contentType が未指定の場合 badRequest を呼ぶ', async () => {
    const ctx = createMockContext({
      query: {},
      request: {
        body: {},
        files: { files: { filepath: tempFile.filepath, mimetype: 'text/csv', size: 100 } },
      },
    });

    await expect(controller.import(ctx)).rejects.toThrow();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      expect.stringContaining('contentType'),
      expect.any(Object)
    );
  });

  it('ファイルが未添付の場合 badRequest を呼ぶ', async () => {
    const ctx = createMockContext({
      query: { contentType: 'api::article.article' },
      request: { body: {}, files: undefined },
    });

    await expect(controller.import(ctx)).rejects.toThrow();
    expect(ctx.badRequest).toHaveBeenCalled();
  });

  it('不正な MIME タイプの場合 badRequest を呼ぶ', async () => {
    const ctx = createMockContext({
      query: { contentType: 'api::article.article' },
      request: {
        body: {},
        files: {
          files: {
            filepath: tempFile.filepath,
            mimetype: 'application/pdf', // ← 不正
            size: 100,
          },
        },
      },
    });

    await expect(controller.import(ctx)).rejects.toThrow();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      expect.stringContaining('許可されていないファイル形式'),
      expect.any(Object)
    );
  });

  it('ファイルサイズ超過の場合 badRequest を呼ぶ', async () => {
    const ctx = createMockContext({
      query: { contentType: 'api::article.article' },
      request: {
        body: {},
        files: {
          files: {
            filepath: tempFile.filepath,
            mimetype: 'text/csv',
            size: 11 * 1024 * 1024, // 11MB > 10MB 上限
          },
        },
      },
    });

    await expect(controller.import(ctx)).rejects.toThrow();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      expect.stringContaining('ファイルサイズ'),
      expect.any(Object)
    );
  });

  it('Service がエラーを throw した場合 logger.error を呼び ctx.throw(500) する', async () => {
    service = createMockService({
      importCsv: vi.fn().mockRejectedValue(new Error('Unexpected DB failure')),
    });
    controller = csvControllerFactory({ strapi: createFakeStrapi(service, logger) });

    const ctx = createMockContext({
      query: { contentType: 'api::article.article' },
      request: {
        body: {},
        files: {
          files: { filepath: tempFile.filepath, mimetype: 'text/csv', size: 100 },
        },
      },
    });

    await expect(controller.import(ctx)).rejects.toMatchObject({ status: 500 });
    expect(logger.error).toHaveBeenCalledWith(
      '[csv-io] Import failed:',
      expect.any(Error)
    );
  });
});

// ---------------------------------------------------------------------------
// export エンドポイントのテスト
// ---------------------------------------------------------------------------

describe('csvController.export', () => {
  let service: ICsvIoService;
  let logger: ILogger;
  let controller: { import: (ctx: unknown) => Promise<void>; export: (ctx: unknown) => Promise<void> };

  beforeEach(() => {
    service = createMockService();
    logger = createMockLogger();
    controller = csvControllerFactory({ strapi: createFakeStrapi(service, logger) });
  });

  it('正常なリクエストで 200 とファイルを返す', async () => {
    const ctx = createMockContext({
      query: { contentType: 'api::article.article' },
    });

    await controller.export(ctx);

    expect(ctx.response.status).toBe(200);
    expect(ctx.response.body).toBe(SUCCESS_EXPORT_RESULT.data);
    expect(ctx.response.headers['Content-Type']).toContain('text/csv');
    expect(ctx.response.headers['Content-Disposition']).toContain('attachment');
  });

  it('contentType が未指定の場合 badRequest を呼ぶ', async () => {
    const ctx = createMockContext({ query: {} });

    await expect(controller.export(ctx)).rejects.toThrow();
    expect(ctx.badRequest).toHaveBeenCalledWith(
      expect.stringContaining('contentType'),
      expect.any(Object)
    );
  });

  it('excludeFields クエリが ProcessorOptions に渡される', async () => {
    const ctx = createMockContext({
      query: {
        contentType: 'api::article.article',
        excludeFields: 'documentId,createdAt,updatedAt',
      },
    });

    await controller.export(ctx);

    expect(service.exportCsv).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeFields: ['documentId', 'createdAt', 'updatedAt'],
      })
    );
  });

  it('locale クエリが ProcessorOptions に渡される', async () => {
    const ctx = createMockContext({
      query: { contentType: 'api::article.article', locale: 'ja' },
    });

    await controller.export(ctx);

    expect(service.exportCsv).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'ja' })
    );
  });

  it('Service がエラーを throw した場合 logger.error を呼び ctx.throw(500) する', async () => {
    service = createMockService({
      exportCsv: vi.fn().mockRejectedValue(new Error('Serialize failed')),
    });
    controller = csvControllerFactory({ strapi: createFakeStrapi(service, logger) });

    const ctx = createMockContext({
      query: { contentType: 'api::article.article' },
    });

    await expect(controller.export(ctx)).rejects.toMatchObject({ status: 500 });
    expect(logger.error).toHaveBeenCalledWith(
      '[csv-io] Export failed:',
      expect.any(Error)
    );
  });
});
