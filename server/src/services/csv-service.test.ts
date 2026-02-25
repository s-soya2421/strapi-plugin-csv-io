/**
 * @file csv-service.test.ts
 * @description
 * csv-service.ts に含まれる各クラスのユニットテスト。
 *
 * テスト対象:
 *  - CsvImportStrategy : csv-parse を使ったパース
 *  - CsvExportStrategy : csv-stringify を使ったシリアライズ
 *  - DataImporter      : create / update の振り分けロジック
 *  - DataExporter      : ページネーション全件取得ロジック
 *
 * モック戦略:
 *  - CsvImportStrategy / CsvExportStrategy : 実際の csv-parse / csv-stringify を使用
 *    （ライブラリの動作を含めた結合テスト）
 *  - DataImporter / DataExporter : IDocumentRepository をモック化した純粋なユニットテスト
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';

import {
  CsvImportStrategy,
  CsvExportStrategy,
  DataImporter,
  DataExporter,
} from './csv-service';

import type {
  IDocumentRepository,
  StrapiDocument,
  ProcessorOptions,
} from '../interfaces/data-processor';

// ---------------------------------------------------------------------------
// テスト用フィクスチャ
// ---------------------------------------------------------------------------

const BASE_OPTIONS: ProcessorOptions = {
  contentType: 'api::article.article',
};

const SAMPLE_DOCUMENTS: StrapiDocument[] = [
  {
    documentId: 'doc-1',
    title: 'Hello World',
    slug: 'hello-world',
    views: 42,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  },
  {
    documentId: 'doc-2',
    title: 'Second Post',
    slug: 'second-post',
    views: 10,
    createdAt: '2024-02-01T00:00:00.000Z',
    updatedAt: '2024-02-02T00:00:00.000Z',
  },
];

/** IDocumentRepository の最小モック生成ヘルパー */
function createMockRepository(
  overrides: Partial<IDocumentRepository> = {}
): IDocumentRepository {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(
      async (_ct, data) => ({ documentId: 'new-doc', ...data })
    ),
    update: vi.fn().mockImplementation(
      async (_ct, documentId, data) => ({ documentId, ...data })
    ),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CsvImportStrategy
// ---------------------------------------------------------------------------

describe('CsvImportStrategy', () => {
  let strategy: CsvImportStrategy;

  beforeEach(() => {
    strategy = new CsvImportStrategy(parse);
  });

  it('正常な CSV 文字列をオブジェクト配列へ変換できる', async () => {
    const csv = `title,slug,views\nHello World,hello-world,42\nSecond Post,second-post,10`;
    const result = await strategy.parse(csv, BASE_OPTIONS);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ title: 'Hello World', slug: 'hello-world', views: 42 });
    expect(result[1]).toEqual({ title: 'Second Post', slug: 'second-post', views: 10 });
  });

  it('数値文字列を数値型へ自動キャストする', async () => {
    const csv = `count,flag\n100,true\n0,false`;
    const result = await strategy.parse(csv, BASE_OPTIONS);

    // csv-parse の cast:true は数値のみキャストする。
    // boolean 文字列 'true'/'false' は文字列のまま返る（仕様通り）。
    expect(typeof result[0]?.['count']).toBe('number');
    expect(result[0]?.['count']).toBe(100);
    expect(result[0]?.['flag']).toBe('true');
  });

  it('空行をスキップする', async () => {
    const csv = `title,slug\nHello,hello\n\nWorld,world`;
    const result = await strategy.parse(csv, BASE_OPTIONS);

    expect(result).toHaveLength(2);
  });

  it('BOM 付き UTF-8 CSV を正常にパースできる', async () => {
    // BOM (0xEF 0xBB 0xBF) を先頭に付与
    const bom = '\uFEFF';
    const csv = `${bom}title,slug\nHello,hello`;
    const result = await strategy.parse(Buffer.from(csv, 'utf-8'), BASE_OPTIONS);

    expect(result).toHaveLength(1);
    // BOM が title キーに混入していないことを確認
    expect(Object.keys(result[0] ?? {})[0]).toBe('title');
  });

  it('ヘッダーのみの CSV は空配列を返す', async () => {
    const csv = `title,slug`;
    const result = await strategy.parse(csv, BASE_OPTIONS);

    expect(result).toHaveLength(0);
  });

  it('不正な CSV（引用符の閉じ忘れ等）はエラーを throw する', async () => {
    const malformed = `title,slug\n"Hello,hello`;
    await expect(strategy.parse(malformed, BASE_OPTIONS)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CsvExportStrategy
// ---------------------------------------------------------------------------

describe('CsvExportStrategy', () => {
  let strategy: CsvExportStrategy;

  beforeEach(() => {
    strategy = new CsvExportStrategy(stringify);
  });

  it('ドキュメント配列を CSV 文字列へ変換できる', async () => {
    const result = await strategy.format(SAMPLE_DOCUMENTS, BASE_OPTIONS);

    expect(result.mimeType).toContain('text/csv');
    expect(typeof result.data).toBe('string');
    expect(result.data as string).toContain('title');
    expect(result.data as string).toContain('Hello World');
  });

  it('excludeFields で指定したフィールドを除外できる', async () => {
    const options: ProcessorOptions = {
      ...BASE_OPTIONS,
      excludeFields: ['documentId', 'createdAt', 'updatedAt'],
    };
    const result = await strategy.format(SAMPLE_DOCUMENTS, options);
    const csv = result.data as string;

    expect(csv).not.toContain('documentId');
    expect(csv).not.toContain('createdAt');
    expect(csv).toContain('title');
    expect(csv).toContain('slug');
  });

  it('空配列を渡した場合は空文字列を返す', async () => {
    const result = await strategy.format([], BASE_OPTIONS);
    expect(result.data).toBe('');
  });

  it('ファイル名にコンテンツタイプが含まれる', async () => {
    const result = await strategy.format(SAMPLE_DOCUMENTS, BASE_OPTIONS);
    expect(result.filename).toContain('api__article_article');
    expect(result.filename).toMatch(/\.csv$/);
  });
});

// ---------------------------------------------------------------------------
// DataImporter
// ---------------------------------------------------------------------------

describe('DataImporter', () => {
  describe('idField 未指定の場合（常に新規作成）', () => {
    it('全レコードを create する', async () => {
      const repository = createMockRepository();
      const importer = new DataImporter(repository);
      const strategy = new CsvImportStrategy(parse);

      const csv = `title,slug\nHello,hello\nWorld,world`;
      const result = await importer.import(csv, strategy, BASE_OPTIONS);

      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(0);
      expect(repository.create).toHaveBeenCalledTimes(2);
    });

    it('create に Strapi 内部フィールドが含まれない', async () => {
      const repository = createMockRepository();
      const importer = new DataImporter(repository);
      const strategy = new CsvImportStrategy(parse);

      const csv = `title,documentId,createdAt\nHello,old-id,2024-01-01`;
      await importer.import(csv, strategy, BASE_OPTIONS);

      // create(contentType, data, locale?) なので index 1 がデータ
    const [, data] = (repository.create as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        Record<string, unknown>,
        string | undefined
      ];
      expect(data).not.toHaveProperty('documentId');
      expect(data).not.toHaveProperty('createdAt');
      expect(data).toHaveProperty('title', 'Hello');
    });
  });

  describe('idField 指定の場合（upsert）', () => {
    it('既存レコードが見つかれば update する', async () => {
      const existing: StrapiDocument = { documentId: 'doc-1', slug: 'hello' };
      const repository = createMockRepository({
        findFirst: vi.fn().mockResolvedValue(existing),
      });
      const importer = new DataImporter(repository);
      const strategy = new CsvImportStrategy(parse);

      const csv = `title,slug\nHello Updated,hello`;
      const options: ProcessorOptions = { ...BASE_OPTIONS, idField: 'slug' };
      const result = await importer.import(csv, strategy, options);

      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      // sanitizeRecord は Strapi 内部フィールド(documentId等)のみ除去する。
      // slug は内部フィールドではないため update データに含まれる（正しい動作）。
      expect(repository.update).toHaveBeenCalledWith(
        BASE_OPTIONS.contentType,
        'doc-1',
        expect.objectContaining({ title: 'Hello Updated', slug: 'hello' }),
        undefined
      );
    });

    it('既存レコードがなければ create する', async () => {
      const repository = createMockRepository({
        findFirst: vi.fn().mockResolvedValue(null),
      });
      const importer = new DataImporter(repository);
      const strategy = new CsvImportStrategy(parse);

      const csv = `title,slug\nNew Post,new-post`;
      const options: ProcessorOptions = { ...BASE_OPTIONS, idField: 'slug' };
      const result = await importer.import(csv, strategy, options);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('idField の値が空の行は create する', async () => {
      const repository = createMockRepository();
      const importer = new DataImporter(repository);
      const strategy = new CsvImportStrategy(parse);

      const csv = `title,slug\nNo Slug,`;
      const options: ProcessorOptions = { ...BASE_OPTIONS, idField: 'slug' };
      const result = await importer.import(csv, strategy, options);

      expect(result.created).toBe(1);
      expect(repository.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('エラーハンドリング', () => {
    it('CSV パースエラーはresult.errorsに記録され failed が増加する', async () => {
      const repository = createMockRepository();
      const importer = new DataImporter(repository);
      const strategy = new CsvImportStrategy(parse);

      const malformed = `title,slug\n"Broken`;
      const result = await importer.import(malformed, strategy, BASE_OPTIONS);

      expect(result.failed).toBeGreaterThan(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.row).toBe(-1); // パースエラーは row: -1
    });

    it('DB 書き込みエラーは該当行の errors に記録される', async () => {
      const repository = createMockRepository({
        create: vi.fn().mockRejectedValue(new Error('DB connection error')),
      });
      const importer = new DataImporter(repository);
      const strategy = new CsvImportStrategy(parse);

      const csv = `title,slug\nHello,hello\nWorld,world`;
      const result = await importer.import(csv, strategy, BASE_OPTIONS);

      expect(result.failed).toBe(2);
      expect(result.created).toBe(0);
      expect(result.errors[0]?.message).toContain('DB connection error');
    });

    it('一部の行が失敗しても他の行は処理を継続する', async () => {
      let callCount = 0;
      const repository = createMockRepository({
        create: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) throw new Error('First row failed');
          return { documentId: 'new-doc' };
        }),
      });
      const importer = new DataImporter(repository);
      const strategy = new CsvImportStrategy(parse);

      const csv = `title\nFirst\nSecond\nThird`;
      const result = await importer.import(csv, strategy, BASE_OPTIONS);

      expect(result.failed).toBe(1);
      expect(result.created).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// DataExporter
// ---------------------------------------------------------------------------

describe('DataExporter', () => {
  it('1ページに収まる件数は findMany を1回だけ呼ぶ', async () => {
    const docs = SAMPLE_DOCUMENTS;
    const repository = createMockRepository({
      findMany: vi.fn().mockResolvedValue(docs),
    });
    const exporter = new DataExporter(repository);
    const strategy = new CsvExportStrategy(stringify);

    await exporter.export(strategy, BASE_OPTIONS);

    expect(repository.findMany).toHaveBeenCalledTimes(1);
    expect(repository.findMany).toHaveBeenCalledWith(
      BASE_OPTIONS.contentType,
      expect.objectContaining({ pagination: { page: 1, pageSize: 500 } })
    );
  });

  it('ページサイズを超える場合は複数ページを取得する', async () => {
    // DataExporter の PAGE_SIZE = 500 をエミュレート
    const PAGE_SIZE = 500;
    const firstBatch = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      documentId: `doc-${i}`,
      title: `Article ${i}`,
    }));
    const secondBatch = [{ documentId: 'doc-last', title: 'Last Article' }];

    const repository = createMockRepository({
      findMany: vi
        .fn()
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce(secondBatch),
    });
    const exporter = new DataExporter(repository);
    const strategy = new CsvExportStrategy(stringify);

    await exporter.export(strategy, BASE_OPTIONS);

    expect(repository.findMany).toHaveBeenCalledTimes(2);
    expect(repository.findMany).toHaveBeenNthCalledWith(
      2,
      BASE_OPTIONS.contentType,
      expect.objectContaining({ pagination: { page: 2, pageSize: PAGE_SIZE } })
    );
  });

  it('locale オプションが findMany に渡される', async () => {
    const repository = createMockRepository({
      findMany: vi.fn().mockResolvedValue([]),
    });
    const exporter = new DataExporter(repository);
    const strategy = new CsvExportStrategy(stringify);
    const options: ProcessorOptions = { ...BASE_OPTIONS, locale: 'ja' };

    await exporter.export(strategy, options);

    expect(repository.findMany).toHaveBeenCalledWith(
      BASE_OPTIONS.contentType,
      expect.objectContaining({ locale: 'ja' })
    );
  });

  it('ドキュメントが0件の場合も正常に ExportResult を返す', async () => {
    const repository = createMockRepository({
      findMany: vi.fn().mockResolvedValue([]),
    });
    const exporter = new DataExporter(repository);
    const strategy = new CsvExportStrategy(stringify);

    const result = await exporter.export(strategy, BASE_OPTIONS);
    expect(result.data).toBe('');
    expect(result.mimeType).toContain('text/csv');
  });
});
