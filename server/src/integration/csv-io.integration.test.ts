/**
 * @file csv-io.integration.test.ts
 * @description
 * CSV インポート/エクスポートの統合テスト。
 *
 * テスト戦略:
 *  - Strapi の境界（IDocumentRepository）だけを InMemoryDocumentRepository に差し替え
 *  - Controller → CsvIoService → DataImporter/Exporter → CsvImportStrategy/ExportStrategy
 *    の全レイヤーを実際につなげて動作を検証する
 *  - CSV ファイルは一時ファイルとして書き出し、実際のファイルI/Oも通す
 *
 * テストシナリオ:
 *  1. インポート - 新規作成
 *  2. インポート - upsertモード（idField指定）
 *  3. エクスポート - 基本
 *  4. エクスポート - フィールド除外
 *  5. ラウンドトリップ（エクスポート→インポート）
 *  6. 大量データ（ページネーション）
 *  7. 部分失敗（207 Multi-Status）
 *  8. localeパラメータの伝播
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';

import {
  CsvImportStrategy,
  CsvExportStrategy,
  DataImporter,
  DataExporter,
  CsvIoService,
} from '../services/csv-service';
import csvControllerFactory from '../controllers/csv-controller';
import { InMemoryDocumentRepository } from './in-memory-repository';

import type { ILogger, ICsvIoService } from '../interfaces/data-processor';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const CONTENT_TYPE = 'api::article.article';

// ---------------------------------------------------------------------------
// ヘルパー: テストスタック構築
// ---------------------------------------------------------------------------

/**
 * 全レイヤーを本物でつないだテスト用スタックを構築する。
 * リポジトリ層だけ InMemoryDocumentRepository を使用。
 */
function buildStack(repository: InMemoryDocumentRepository): {
  controller: { import: (ctx: unknown) => Promise<void>; export: (ctx: unknown) => Promise<void> };
  service: ICsvIoService;
  logger: ILogger;
} {
  const importStrategy = new CsvImportStrategy(parse);
  const exportStrategy = new CsvExportStrategy(stringify);
  const importer = new DataImporter(repository);
  const exporter = new DataExporter(repository);
  const service = new CsvIoService(importer, exporter, importStrategy, exportStrategy);

  const logger: ILogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };

  const fakeStrapi = {
    plugin: (_name: string) => ({ service: (_svc: string) => service }),
    log: logger,
  };

  const controller = csvControllerFactory({ strapi: fakeStrapi });
  return { controller, service, logger };
}

// ---------------------------------------------------------------------------
// ヘルパー: 一時CSVファイル作成
// ---------------------------------------------------------------------------

interface TempFile {
  filepath: string;
  cleanup: () => void;
}

function createTempCsvFile(content: string): TempFile {
  const filepath = path.join(os.tmpdir(), `integration-test-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(filepath, content, 'utf-8');
  return {
    filepath,
    cleanup: () => {
      try { fs.unlinkSync(filepath); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// ヘルパー: モックKoaコンテキスト
// ---------------------------------------------------------------------------

interface MockResponse {
  body: unknown;
  status: number;
  headers: Record<string, string>;
}

interface MockContext {
  request: { body: Record<string, unknown>; files?: Record<string, unknown> };
  query: Record<string, string>;
  params: Record<string, string>;
  response: MockResponse & {
    set(key: string, value: string): void;
    attachment(filename: string): void;
  };
  badRequest: ReturnType<typeof vi.fn>;
  throw: ReturnType<typeof vi.fn>;
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext {
  const headers: Record<string, string> = {};
  return {
    request: { body: {} },
    query: {},
    params: {},
    response: {
      body: undefined,
      status: 200,
      headers,
      set(key: string, value: string) { headers[key] = value; },
      attachment(filename: string) { headers['Content-Disposition'] = `attachment; filename="${filename}"`; },
    },
    badRequest: vi.fn().mockImplementation((msg: string, details: unknown) => {
      throw Object.assign(new Error(msg), { status: 400, details });
    }),
    throw: vi.fn().mockImplementation((status: number, msg?: string) => {
      throw Object.assign(new Error(msg ?? 'Error'), { status });
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ヘルパー: インポートコンテキスト生成
// ---------------------------------------------------------------------------

function createImportContext(
  filepath: string,
  query: Record<string, string> = { contentType: CONTENT_TYPE }
): MockContext {
  return createMockContext({
    query,
    request: {
      body: {},
      files: {
        files: { filepath, mimetype: 'text/csv', size: 100 },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// ヘルパー: CSV文字列をオブジェクト配列へパース
// ---------------------------------------------------------------------------

async function parseCsvString(csv: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const records: Record<string, unknown>[] = [];
    const parser = parse(csv, { columns: true, skip_empty_lines: true, cast: true });
    parser.on('readable', () => {
      let record: Record<string, unknown> | null;
      // eslint-disable-next-line no-cond-assign
      while ((record = parser.read() as Record<string, unknown> | null) !== null) {
        records.push(record);
      }
    });
    parser.on('error', reject);
    parser.on('end', () => resolve(records));
  });
}

// ===========================================================================
// テスト
// ===========================================================================

describe('CSV IO 統合テスト', () => {
  let repository: InMemoryDocumentRepository;

  beforeEach(() => {
    repository = new InMemoryDocumentRepository();
  });

  // -------------------------------------------------------------------------
  // 1. インポート - 新規作成
  // -------------------------------------------------------------------------

  describe('シナリオ1: インポート - 新規作成', () => {
    it('CSV 2行が repository に create され、レスポンスが created=2 を返す', async () => {
      const { controller } = buildStack(repository);

      const csvContent = 'title,slug,views\nHello World,hello-world,42\nSecond Post,second-post,10';
      const tmp = createTempCsvFile(csvContent);

      try {
        const ctx = createImportContext(tmp.filepath);
        await controller.import(ctx);

        // HTTP レスポンス検証
        expect(ctx.response.status).toBe(200);
        expect(ctx.response.body).toMatchObject({
          data: { created: 2, updated: 0, failed: 0 },
        });

        // リポジトリに実際に保存されているか検証
        const docs = repository.getAllDocuments(CONTENT_TYPE);
        expect(docs).toHaveLength(2);

        const titles = docs.map((d) => d['title']).sort();
        expect(titles).toEqual(['Hello World', 'Second Post']);

        // 数値フィールドが正しく型変換されているか
        const helloDoc = docs.find((d) => d['slug'] === 'hello-world');
        expect(helloDoc?.['views']).toBe(42);
      } finally {
        tmp.cleanup();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. インポート - upsertモード
  // -------------------------------------------------------------------------

  describe('シナリオ2: インポート - upsertモード', () => {
    it('既存レコードは更新、未存在レコードは新規作成される', async () => {
      const { controller } = buildStack(repository);

      // 既存データをシード
      repository.seed(CONTENT_TYPE, [
        { title: 'Old Title', slug: 'hello-world' },
      ]);

      const csvContent = [
        'title,slug',
        'Updated Title,hello-world', // 既存 → update
        'Brand New Post,new-post',   // 未存在 → create
      ].join('\n');

      const tmp = createTempCsvFile(csvContent);

      try {
        const ctx = createImportContext(tmp.filepath, {
          contentType: CONTENT_TYPE,
          idField: 'slug',
        });
        await controller.import(ctx);

        expect(ctx.response.status).toBe(200);
        expect(ctx.response.body).toMatchObject({
          data: { updated: 1, created: 1, failed: 0 },
        });

        // リポジトリの状態を確認
        const docs = repository.getAllDocuments(CONTENT_TYPE);
        expect(docs).toHaveLength(2);

        const updatedDoc = docs.find((d) => d['slug'] === 'hello-world');
        expect(updatedDoc?.['title']).toBe('Updated Title');

        const newDoc = docs.find((d) => d['slug'] === 'new-post');
        expect(newDoc?.['title']).toBe('Brand New Post');
      } finally {
        tmp.cleanup();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. エクスポート - 基本
  // -------------------------------------------------------------------------

  describe('シナリオ3: エクスポート - 基本', () => {
    it('シードしたドキュメントが正しく CSV としてエクスポートされる', async () => {
      const { controller } = buildStack(repository);

      repository.seed(CONTENT_TYPE, [
        { title: 'Article A', slug: 'article-a', views: 100 },
        { title: 'Article B', slug: 'article-b', views: 200 },
        { title: 'Article C', slug: 'article-c', views: 300 },
      ]);

      const ctx = createMockContext({ query: { contentType: CONTENT_TYPE } });
      await controller.export(ctx);

      expect(ctx.response.status).toBe(200);
      expect(ctx.response.headers['Content-Type']).toContain('text/csv');
      expect(ctx.response.headers['Content-Disposition']).toContain('attachment');

      // CSV をパースして元データと照合
      const csv = ctx.response.body as string;
      const parsed = await parseCsvString(csv);

      expect(parsed).toHaveLength(3);
      const slugs = parsed.map((r) => r['slug']).sort();
      expect(slugs).toEqual(['article-a', 'article-b', 'article-c']);
      const views = parsed.find((r) => r['slug'] === 'article-b')?.['views'];
      expect(views).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // 4. エクスポート - フィールド除外
  // -------------------------------------------------------------------------

  describe('シナリオ4: エクスポート - フィールド除外', () => {
    it('excludeFields に指定したフィールドが CSV に含まれない', async () => {
      const { controller } = buildStack(repository);

      repository.seed(CONTENT_TYPE, [
        { title: 'Article A', slug: 'article-a' },
      ]);

      const ctx = createMockContext({
        query: {
          contentType: CONTENT_TYPE,
          excludeFields: 'documentId,createdAt,updatedAt',
        },
      });
      await controller.export(ctx);

      const csv = ctx.response.body as string;
      expect(csv).not.toContain('documentId');
      expect(csv).not.toContain('createdAt');
      expect(csv).not.toContain('updatedAt');
      expect(csv).toContain('title');
      expect(csv).toContain('slug');
    });
  });

  // -------------------------------------------------------------------------
  // 5. ラウンドトリップ（エクスポート→インポート）
  // -------------------------------------------------------------------------

  describe('シナリオ5: ラウンドトリップ', () => {
    it('エクスポートしたデータを修正して再インポートするとデータが更新される', async () => {
      // --- Step 1: 初期データをシード ---
      repository.seed(CONTENT_TYPE, [
        { title: 'Original Title', slug: 'my-article', views: 10 },
      ]);

      const { controller } = buildStack(repository);

      // --- Step 2: エクスポート ---
      const exportCtx = createMockContext({ query: { contentType: CONTENT_TYPE } });
      await controller.export(exportCtx);

      const exportedCsv = exportCtx.response.body as string;
      expect(exportedCsv).toContain('Original Title');

      // --- Step 3: CSVを修正（タイトル変更） ---
      const modifiedCsv = exportedCsv.replace('Original Title', 'Updated Title');

      // --- Step 4: 修正したCSVを再インポート（idField=slug でupsert）---
      const tmp = createTempCsvFile(modifiedCsv);
      try {
        const importCtx = createImportContext(tmp.filepath, {
          contentType: CONTENT_TYPE,
          idField: 'slug',
        });
        await controller.import(importCtx);

        expect(importCtx.response.body).toMatchObject({
          data: { updated: 1, created: 0, failed: 0 },
        });

        // --- Step 5: データの整合性確認 ---
        const docs = repository.getAllDocuments(CONTENT_TYPE);
        // upsert なので件数は変わらない（重複しない）
        expect(docs).toHaveLength(1);
        expect(docs[0]?.['title']).toBe('Updated Title');
        expect(docs[0]?.['slug']).toBe('my-article');
      } finally {
        tmp.cleanup();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. 大量データ（ページネーション）
  // -------------------------------------------------------------------------

  describe('シナリオ6: 大量データ - ページネーション', () => {
    it('601件のドキュメントが2ページで全件エクスポートされる', async () => {
      const { controller } = buildStack(repository);

      // 601件シード（PageSize=500 を超える）
      const TOTAL = 601;
      const docs = Array.from({ length: TOTAL }, (_, i) => ({
        title: `Article ${i + 1}`,
        slug: `article-${i + 1}`,
      }));
      repository.seed(CONTENT_TYPE, docs);

      const ctx = createMockContext({ query: { contentType: CONTENT_TYPE } });
      await controller.export(ctx);

      expect(ctx.response.status).toBe(200);

      // CSVに601件が全て含まれているか
      const csv = ctx.response.body as string;
      const parsed = await parseCsvString(csv);
      expect(parsed).toHaveLength(TOTAL);

      // 全スラグがユニークか
      const slugs = new Set(parsed.map((r) => r['slug']));
      expect(slugs.size).toBe(TOTAL);
    });
  });

  // -------------------------------------------------------------------------
  // 7. 部分失敗（207 Multi-Status）
  // -------------------------------------------------------------------------

  describe('シナリオ7: 部分失敗 - 207 Multi-Status', () => {
    it('一部の行でDB書き込みエラーが起きた場合 207 と errors が返る', async () => {
      // 2回目の create だけ失敗するリポジトリ
      let createCallCount = 0;
      const faultyRepository = new InMemoryDocumentRepository();

      // create をオーバーライドするためにスパイを設定
      const originalCreate = faultyRepository.create.bind(faultyRepository);
      vi.spyOn(faultyRepository, 'create').mockImplementation(async (...args) => {
        createCallCount++;
        if (createCallCount === 2) {
          throw new Error('DB write error for row 2');
        }
        return originalCreate(...args);
      });

      const { controller } = buildStack(faultyRepository);

      const csvContent = 'title,slug\nRow One,row-one\nRow Two,row-two\nRow Three,row-three';
      const tmp = createTempCsvFile(csvContent);

      try {
        const ctx = createImportContext(tmp.filepath);
        await controller.import(ctx);

        // 207 Multi-Status
        expect(ctx.response.status).toBe(207);

        const body = ctx.response.body as {
          data: { created: number; failed: number };
          errors: Array<{ row: number; message: string }>;
        };
        expect(body.data.created).toBe(2); // 1行目と3行目は成功
        expect(body.data.failed).toBe(1);  // 2行目は失敗
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0]?.message).toContain('DB write error for row 2');
      } finally {
        tmp.cleanup();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 8. localeパラメータの伝播
  // -------------------------------------------------------------------------

  describe('シナリオ8: localeパラメータ', () => {
    it('インポート時に locale が repository.create に渡される', async () => {
      const { controller } = buildStack(repository);

      const spy = vi.spyOn(repository, 'create');

      const csvContent = 'title,slug\n日本語記事,japanese-article';
      const tmp = createTempCsvFile(csvContent);

      try {
        const ctx = createImportContext(tmp.filepath, {
          contentType: CONTENT_TYPE,
          locale: 'ja',
        });
        await controller.import(ctx);

        expect(spy).toHaveBeenCalledWith(
          CONTENT_TYPE,
          expect.objectContaining({ title: '日本語記事' }),
          'ja'
        );
      } finally {
        tmp.cleanup();
      }
    });

    it('エクスポート時に locale が repository.findMany に渡される', async () => {
      const { controller } = buildStack(repository);

      const spy = vi.spyOn(repository, 'findMany');

      const ctx = createMockContext({
        query: { contentType: CONTENT_TYPE, locale: 'ja' },
      });
      await controller.export(ctx);

      expect(spy).toHaveBeenCalledWith(
        CONTENT_TYPE,
        expect.objectContaining({ locale: 'ja' })
      );
    });
  });
});
