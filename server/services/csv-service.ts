/**
 * @file csv-service.ts
 * @description
 * CSV インポート/エクスポートのコア実装。
 *
 * 含まれるクラス:
 *  - CsvImportStrategy : csv-parse を用いた IImportStrategy 実装
 *  - CsvExportStrategy : csv-stringify を用いた IExportStrategy 実装
 *  - StrapiDocumentRepository : Strapi v5 Document API の IDocumentRepository 実装
 *  - DataImporter         : IDataImporter 実装（インポートユースケース）
 *  - DataExporter         : IDataExporter 実装（エクスポートユースケース）
 *  - StrategyRegistry     : ストラテジー管理レジストリ
 *  - CsvIoService         : ICsvIoService ファサード（Controller が直接利用）
 *
 * 設計上の注意:
 *  - Strapi の `strapi` グローバルには直接依存しない。
 *    StrapiDocumentRepository のコンストラクタに注入する。
 *  - csv-parse / csv-stringify の型は peer dependency を前提とし、
 *    ここでは型のみインポートする想定。
 */

import type { parse as ParseFn, Options as ParseOptions } from 'csv-parse';
import type { stringify as StringifyFn, Options as StringifyOptions } from 'csv-stringify';

import type {
  IImportStrategy,
  IExportStrategy,
  IDocumentRepository,
  IDataImporter,
  IDataExporter,
  IStrategyRegistry,
  ICsvIoService,
  StrapiDocument,
  DocumentQueryParams,
  ProcessorOptions,
  ImportResult,
  ImportError,
  ExportResult,
} from '../interfaces/data-processor';

// ---------------------------------------------------------------------------
// 型エイリアス: Strapi の Core.Strapi 型を直接インポートせず、
// 必要なメソッドシグネチャのみを定義する (Dependency Inversion)
// ---------------------------------------------------------------------------

/**
 * StrapiDocumentRepository が要求する Strapi インスタンスの最小インターフェース。
 * Strapi 本体の型に依存せず、必要なシグネチャだけを定義する。
 */
export interface StrapiDocumentsApi {
  documents(uid: string): {
    findMany(params?: DocumentQueryParams): Promise<StrapiDocument[]>;
    findFirst(params?: DocumentQueryParams): Promise<StrapiDocument | null>;
    create(params: {
      data: Record<string, unknown>;
      locale?: string;
    }): Promise<StrapiDocument>;
    update(params: {
      documentId: string;
      data: Record<string, unknown>;
      locale?: string;
    }): Promise<StrapiDocument>;
  };
}

// ---------------------------------------------------------------------------
// CsvImportStrategy
// Single Responsibility: CSV のパースのみを責務とする
// ---------------------------------------------------------------------------

export class CsvImportStrategy implements IImportStrategy {
  readonly mimeTypes = ['text/csv', 'application/csv'] as const;
  readonly fileExtensions = ['csv'] as const;

  /**
   * @param parseFn - csv-parse の `parse` 関数（DI）
   * @param defaultParseOptions - csv-parse のデフォルトオプション（上書き可能）
   */
  constructor(
    private readonly parseFn: typeof ParseFn,
    private readonly defaultParseOptions: ParseOptions = {}
  ) {}

  async parse(
    input: Buffer | string,
    _options: ProcessorOptions
  ): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const records: Record<string, unknown>[] = [];

      const parser = this.parseFn(
        typeof input === 'string' ? input : input.toString('utf-8'),
        {
          columns: true,         // 1行目をヘッダーとしてキーにする
          skip_empty_lines: true,
          trim: true,
          cast: true,            // 数値・boolean を自動キャスト
          cast_date: false,      // 日付は文字列のままにして呼び出し元に委ねる
          bom: true,             // BOM 付き UTF-8 に対応
          ...this.defaultParseOptions,
        }
      );

      parser.on('readable', () => {
        let record: Record<string, unknown> | null;
        // eslint-disable-next-line no-cond-assign
        while ((record = parser.read() as Record<string, unknown> | null) !== null) {
          records.push(record);
        }
      });

      parser.on('error', (err: Error) => reject(err));
      parser.on('end', () => resolve(records));
    });
  }
}

// ---------------------------------------------------------------------------
// CsvExportStrategy
// Single Responsibility: CSV へのシリアライズのみを責務とする
// ---------------------------------------------------------------------------

export class CsvExportStrategy implements IExportStrategy {
  readonly mimeType = 'text/csv; charset=utf-8';
  readonly fileExtension = 'csv';

  /**
   * @param stringifyFn - csv-stringify の `stringify` 関数（DI）
   * @param defaultStringifyOptions - csv-stringify のデフォルトオプション（上書き可能）
   */
  constructor(
    private readonly stringifyFn: typeof StringifyFn,
    private readonly defaultStringifyOptions: StringifyOptions = {}
  ) {}

  async format(
    data: StrapiDocument[],
    options: ProcessorOptions
  ): Promise<ExportResult> {
    const excludeFields = new Set(options.excludeFields ?? []);

    // フィールドフィルタリング
    const filtered = data.map((doc) =>
      Object.fromEntries(
        Object.entries(doc).filter(([key]) => !excludeFields.has(key))
      )
    );

    const csvString = await this.stringify(filtered);
    const contentType = options.contentType.replace(/[^a-zA-Z0-9-_]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    return {
      data: csvString,
      mimeType: this.mimeType,
      filename: `export_${contentType}_${timestamp}.csv`,
    };
  }

  private stringify(data: Record<string, unknown>[]): Promise<string> {
    return new Promise((resolve, reject) => {
      if (data.length === 0) {
        resolve('');
        return;
      }

      this.stringifyFn(
        data,
        {
          header: true,
          cast: {
            // null / undefined を空文字列へ変換
            object: (value: unknown) =>
              value === null || value === undefined ? '' : JSON.stringify(value),
          },
          ...this.defaultStringifyOptions,
        },
        (err: Error | null | undefined, output?: string) => {
          if (err) return reject(err);
          resolve(output ?? '');
        }
      );
    });
  }
}

// ---------------------------------------------------------------------------
// StrapiDocumentRepository
// Dependency Inversion: Strapi Document API を抽象化し、
// Service 層は IDocumentRepository にのみ依存する
// ---------------------------------------------------------------------------

export class StrapiDocumentRepository implements IDocumentRepository {
  constructor(private readonly strapi: StrapiDocumentsApi) {}

  async findMany(
    contentType: string,
    params: DocumentQueryParams = {}
  ): Promise<StrapiDocument[]> {
    return this.strapi.documents(contentType).findMany(params);
  }

  async findFirst(
    contentType: string,
    params: DocumentQueryParams = {}
  ): Promise<StrapiDocument | null> {
    return this.strapi.documents(contentType).findFirst(params);
  }

  async create(
    contentType: string,
    data: Record<string, unknown>,
    locale?: string
  ): Promise<StrapiDocument> {
    return this.strapi.documents(contentType).create({ data, locale });
  }

  async update(
    contentType: string,
    documentId: string,
    data: Record<string, unknown>,
    locale?: string
  ): Promise<StrapiDocument> {
    return this.strapi.documents(contentType).update({ documentId, data, locale });
  }
}

// ---------------------------------------------------------------------------
// DataImporter
// Single Responsibility: インポートのオーケストレーション（DB 書き込み調整）のみ
// ---------------------------------------------------------------------------

export class DataImporter implements IDataImporter {
  constructor(private readonly repository: IDocumentRepository) {}

  async import(
    rawData: Buffer | string,
    strategy: IImportStrategy,
    options: ProcessorOptions
  ): Promise<ImportResult> {
    const result: ImportResult = {
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    let records: Record<string, unknown>[];
    try {
      records = await strategy.parse(rawData, options);
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      result.errors.push({ row: -1, message: `ファイルのパースに失敗しました: ${message}` });
      result.failed = 1;
      return result;
    }

    for (const [i, record] of records.entries()) {
      try {
        await this.processRecord(record, i, options, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const importError: ImportError = { row: i, message };
        result.errors.push(importError);
        result.failed++;
      }
    }

    return result;
  }

  private async processRecord(
    record: Record<string, unknown>,
    rowIndex: number,
    options: ProcessorOptions,
    result: ImportResult
  ): Promise<void> {
    const { contentType, locale, idField } = options;

    // Strapi の内部管理フィールドを除去してクリーンなデータを生成
    const data = this.sanitizeRecord(record);

    if (!idField) {
      // idField 未指定: 常に新規作成
      await this.repository.create(contentType, data, locale);
      result.created++;
      return;
    }

    const idValue = record[idField];
    if (idValue === undefined || idValue === null || idValue === '') {
      // idField の値がない行は新規作成
      await this.repository.create(contentType, data, locale);
      result.created++;
      return;
    }

    // 既存レコード検索 → upsert
    const existing = await this.repository.findFirst(contentType, {
      filters: { [idField]: { $eq: idValue } },
      locale,
    });

    if (existing) {
      await this.repository.update(contentType, existing.documentId, data, locale);
      result.updated++;
    } else {
      await this.repository.create(contentType, data, locale);
      result.created++;
    }

    void rowIndex; // 将来のデバッグログ用に保持
  }

  /**
   * インポートデータから Strapi 管理フィールドを除去する。
   * documentId, createdAt 等をそのまま渡すと Strapi がエラーを返すため。
   */
  private sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
    const STRAPI_INTERNAL_FIELDS = new Set([
      'documentId',
      'createdAt',
      'updatedAt',
      'publishedAt',
    ]);

    return Object.fromEntries(
      Object.entries(record).filter(([key]) => !STRAPI_INTERNAL_FIELDS.has(key))
    );
  }
}

// ---------------------------------------------------------------------------
// DataExporter
// Single Responsibility: エクスポートのオーケストレーション（DB 読み取り調整）のみ
// ---------------------------------------------------------------------------

export class DataExporter implements IDataExporter {
  /** 全件取得時のページサイズ上限 */
  private static readonly PAGE_SIZE = 500;

  constructor(private readonly repository: IDocumentRepository) {}

  async export(
    strategy: IExportStrategy,
    options: ProcessorOptions
  ): Promise<ExportResult> {
    const allDocuments = await this.fetchAllDocuments(options);
    return strategy.format(allDocuments, options);
  }

  /**
   * ページネーションを使い全件取得する。
   * Strapi の findMany は最大 pageSize 件しか返さないため、
   * 残りのページを再帰的に取得する。
   */
  private async fetchAllDocuments(options: ProcessorOptions): Promise<StrapiDocument[]> {
    const { contentType, locale } = options;
    const collected: StrapiDocument[] = [];
    let page = 1;

    while (true) {
      const batch = await this.repository.findMany(contentType, {
        locale,
        pagination: { page, pageSize: DataExporter.PAGE_SIZE },
      });

      collected.push(...batch);

      if (batch.length < DataExporter.PAGE_SIZE) {
        // 取得件数がページサイズ未満 → 最終ページ
        break;
      }
      page++;
    }

    return collected;
  }
}

// ---------------------------------------------------------------------------
// StrategyRegistry
// Open/Closed原則の実現: 新フォーマットは登録するだけで使える
// ---------------------------------------------------------------------------

export class StrategyRegistry implements IStrategyRegistry {
  private readonly importStrategies: IImportStrategy[] = [];
  private readonly exportStrategies: IExportStrategy[] = [];

  registerImport(strategy: IImportStrategy): void {
    this.importStrategies.push(strategy);
  }

  registerExport(strategy: IExportStrategy): void {
    this.exportStrategies.push(strategy);
  }

  resolveImport(mimeTypeOrExtension: string): IImportStrategy | null {
    const normalized = mimeTypeOrExtension.toLowerCase().trim();
    return (
      this.importStrategies.find(
        (s) =>
          s.mimeTypes.includes(normalized as never) ||
          s.fileExtensions.includes(normalized as never)
      ) ?? null
    );
  }

  resolveExport(mimeTypeOrExtension: string): IExportStrategy | null {
    const normalized = mimeTypeOrExtension.toLowerCase().trim();
    return (
      this.exportStrategies.find(
        (s) =>
          s.mimeType === normalized ||
          s.fileExtension === normalized
      ) ?? null
    );
  }
}

// ---------------------------------------------------------------------------
// CsvIoService
// Controller が依存するファサード。実装の詳細を隠蔽する。
// ---------------------------------------------------------------------------

export class CsvIoService implements ICsvIoService {
  constructor(
    private readonly importer: IDataImporter,
    private readonly exporter: IDataExporter,
    private readonly importStrategy: IImportStrategy,
    private readonly exportStrategy: IExportStrategy
  ) {}

  async importCsv(fileBuffer: Buffer, options: ProcessorOptions): Promise<ImportResult> {
    return this.importer.import(fileBuffer, this.importStrategy, options);
  }

  async exportCsv(options: ProcessorOptions): Promise<ExportResult> {
    return this.exporter.export(this.exportStrategy, options);
  }
}

// ---------------------------------------------------------------------------
// Strapi Plugin Service ファクトリ
// Strapi v5 のプラグインサービス規約に準拠
// ---------------------------------------------------------------------------

/**
 * Strapi がプラグインサービスとして登録するファクトリ関数。
 *
 * @example
 * // server/index.ts 内での登録例
 * import csvServiceFactory from './services/csv-service';
 * export default {
 *   register({ strapi }) {},
 *   bootstrap({ strapi }) {},
 *   services: { csvService: csvServiceFactory },
 * };
 */
const csvServiceFactory = ({ strapi }: { strapi: StrapiDocumentsApi }) => {
  // 依存オブジェクトの生成（DI コンテナ的な役割）
  // NOTE: 本番では IoC コンテナ（tsyringe 等）への移行も検討可能。

  // csv-parse / csv-stringify の動的インポートにより
  // Strapi の起動時ではなく、リクエスト時に require される
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parse } = require('csv-parse') as { parse: typeof ParseFn };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { stringify } = require('csv-stringify') as { stringify: typeof StringifyFn };

  const repository = new StrapiDocumentRepository(strapi);
  const importStrategy = new CsvImportStrategy(parse);
  const exportStrategy = new CsvExportStrategy(stringify);
  const importer = new DataImporter(repository);
  const exporter = new DataExporter(repository);

  return new CsvIoService(importer, exporter, importStrategy, exportStrategy);
};

export default csvServiceFactory;
