/**
 * @file csv-controller.ts
 * @description
 * HTTP リクエストのバリデーションとレスポンス制御を担う Controller 層。
 *
 * 責務:
 *  - リクエストパラメータのバリデーション
 *  - アップロードファイルの検証（MIME タイプ、サイズ）
 *  - Service の呼び出しと結果のレスポンスへの変換
 *  - エラーハンドリングと適切な HTTP ステータスコードの返却
 *
 * 非責務（Service 層に委譲）:
 *  - データのパース/シリアライズ
 *  - DB へのアクセス
 *
 * Strapi v5 の KoaContext を型引数として利用する。
 */

import type { ICsvIoService, ProcessorOptions, ImportResult, ILogger } from '../interfaces/data-processor';

// ---------------------------------------------------------------------------
// Koa コンテキスト最小インターフェース (Dependency Inversion)
// Koa や Strapi の型パッケージに直接依存しない
// ---------------------------------------------------------------------------

export interface KoaFile {
  filepath: string;
  originalFilename?: string;
  mimetype?: string;
  size: number;
  // Strapi v5 では formidable ベース
  toBuffer?(): Promise<Buffer>;
}

export interface KoaRequest {
  body: Record<string, unknown>;
  files?: Record<string, KoaFile | KoaFile[] | undefined>;
}

export interface KoaResponse {
  body: unknown;
  set(key: string, value: string): void;
  attachment(filename: string): void;
  status: number;
}

export interface KoaContext {
  request: KoaRequest;
  response: KoaResponse;
  query: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
  throw(status: number, message?: string): never;
  badRequest(message: string, details?: Record<string, unknown>): never;
}

// ---------------------------------------------------------------------------
// バリデーション定数
// ---------------------------------------------------------------------------

const ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/octet-stream', // OS によっては CSV がこのタイプで送られる
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// バリデーション結果型
// ---------------------------------------------------------------------------

type ValidationSuccess<T> = { ok: true; value: T };
type ValidationFailure = { ok: false; message: string; details?: Record<string, unknown> };
type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

// ---------------------------------------------------------------------------
// ヘルパー: クエリ文字列の安全な取得
// ---------------------------------------------------------------------------

function getQueryString(
  query: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------------------
// RequestValidator
// Single Responsibility: リクエストのバリデーション処理のみを担う
// ---------------------------------------------------------------------------

class RequestValidator {
  /**
   * インポートリクエストを検証し、ファイル Buffer と ProcessorOptions を返す。
   */
  validateImportRequest(
    ctx: KoaContext
  ): ValidationResult<{ fileBuffer: Buffer; options: ProcessorOptions }> {
    // Content-Type の検証は Strapi のミドルウェアが担保しているため省略。
    // ここではビジネスルールのみ検証する。

    const contentType = this.extractContentType(ctx);
    if (!contentType) {
      return {
        ok: false,
        message: '`contentType` クエリパラメータは必須です。',
        details: { example: 'contentType=api::article.article' },
      };
    }

    const fileValidation = this.extractUploadedFile(ctx);
    if (!fileValidation.ok) return fileValidation;

    const { file } = fileValidation.value;

    // MIME タイプ検証
    const mimeType = file.mimetype ?? '';
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return {
        ok: false,
        message: `許可されていないファイル形式です: "${mimeType}"`,
        details: { allowed: [...ALLOWED_MIME_TYPES] },
      };
    }

    // ファイルサイズ検証
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return {
        ok: false,
        message: `ファイルサイズが上限（${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB）を超えています。`,
        details: { maxSizeBytes: MAX_FILE_SIZE_BYTES, actualSizeBytes: file.size },
      };
    }

    // ファイルを Buffer へ変換
    const fileBuffer = this.readFileBuffer(file);
    if (!fileBuffer) {
      return {
        ok: false,
        message: 'ファイルの読み込みに失敗しました。',
      };
    }

    const options = this.buildProcessorOptions(ctx, contentType);

    return { ok: true, value: { fileBuffer, options } };
  }

  /**
   * エクスポートリクエストを検証し、ProcessorOptions を返す。
   */
  validateExportRequest(ctx: KoaContext): ValidationResult<{ options: ProcessorOptions }> {
    const contentType = this.extractContentType(ctx);
    if (!contentType) {
      return {
        ok: false,
        message: '`contentType` クエリパラメータは必須です。',
        details: { example: 'contentType=api::article.article' },
      };
    }

    const options = this.buildProcessorOptions(ctx, contentType);
    return { ok: true, value: { options } };
  }

  // --- プライベートヘルパー ---

  private extractContentType(ctx: KoaContext): string | undefined {
    // クエリパラメータ優先、次にリクエストボディを参照
    return (
      getQueryString(ctx.query, 'contentType') ??
      (typeof ctx.request.body?.['contentType'] === 'string'
        ? ctx.request.body['contentType']
        : undefined)
    );
  }

  private extractUploadedFile(
    ctx: KoaContext
  ): ValidationResult<{ file: KoaFile }> {
    const files = ctx.request.files;
    if (!files) {
      return { ok: false, message: 'ファイルがアップロードされていません。' };
    }

    const uploadedFile = files['files'] ?? files['file'] ?? files['csv'];
    if (!uploadedFile) {
      return {
        ok: false,
        message: 'フォームフィールド名は "files", "file", または "csv" を使用してください。',
      };
    }

    const file = Array.isArray(uploadedFile) ? uploadedFile[0] : uploadedFile;
    if (!file) {
      return { ok: false, message: 'ファイルが空です。' };
    }

    return { ok: true, value: { file } };
  }

  private readFileBuffer(file: KoaFile): Buffer | null {
    try {
      // Strapi v5 (formidable) ではファイルはディスクに保存される
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs') as typeof import('fs');
      return fs.readFileSync(file.filepath);
    } catch {
      return null;
    }
  }

  private buildProcessorOptions(ctx: KoaContext, contentType: string): ProcessorOptions {
    const excludeFieldsRaw = getQueryString(ctx.query, 'excludeFields');
    const excludeFields = excludeFieldsRaw
      ? excludeFieldsRaw.split(',').map((f) => f.trim()).filter(Boolean)
      : undefined;

    return {
      contentType,
      locale: getQueryString(ctx.query, 'locale'),
      idField: getQueryString(ctx.query, 'idField'),
      excludeFields,
    };
  }
}

// ---------------------------------------------------------------------------
// ResponseBuilder
// Single Responsibility: HTTP レスポンスの構築のみを担う
// ---------------------------------------------------------------------------

class ResponseBuilder {
  buildImportSuccess(ctx: KoaContext, result: ImportResult): void {
    const hasErrors = result.failed > 0;
    ctx.response.status = hasErrors ? 207 : 200; // 207 Multi-Status（一部失敗）

    ctx.response.body = {
      data: {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        failed: result.failed,
      },
      ...(hasErrors && { errors: result.errors }),
      meta: {
        total: result.created + result.updated + result.skipped + result.failed,
      },
    };
  }

  buildExportSuccess(
    ctx: KoaContext,
    data: string | Buffer,
    mimeType: string,
    filename: string
  ): void {
    ctx.response.status = 200;
    ctx.response.set('Content-Type', mimeType);
    ctx.response.set(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`
    );
    ctx.response.set('Cache-Control', 'no-store');
    ctx.response.body = data;
  }

  buildValidationError(
    ctx: KoaContext,
    message: string,
    details?: Record<string, unknown>
  ): void {
    ctx.badRequest(message, details);
  }

  buildServerError(ctx: KoaContext, message: string): void {
    ctx.throw(500, message);
  }
}

// ---------------------------------------------------------------------------
// CsvController
// Single Responsibility: Service 呼び出しとレスポンス変換のオーケストレーション
// ---------------------------------------------------------------------------

class CsvController {
  private readonly validator: RequestValidator;
  private readonly responseBuilder: ResponseBuilder;

  constructor(
    private readonly csvService: ICsvIoService,
    private readonly logger: ILogger
  ) {
    this.validator = new RequestValidator();
    this.responseBuilder = new ResponseBuilder();
  }

  /**
   * POST /csv-io/import
   * multipart/form-data でアップロードされた CSV ファイルをインポートする。
   *
   * Query Parameters:
   *   - contentType (required): 対象コンテンツタイプ UID
   *   - locale (optional): ロケール
   *   - idField (optional): upsert 時の同定フィールド名
   */
  async import(ctx: KoaContext): Promise<void> {
    const validation = this.validator.validateImportRequest(ctx);

    if (!validation.ok) {
      this.responseBuilder.buildValidationError(ctx, validation.message, validation.details);
      return;
    }

    const { fileBuffer, options } = validation.value;

    try {
      const result = await this.csvService.importCsv(fileBuffer, options);
      this.responseBuilder.buildImportSuccess(ctx, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : '予期しないエラーが発生しました。';
      this.logger.error('[csv-import-export] Import failed:', err);
      this.responseBuilder.buildServerError(ctx, `インポート処理中にエラーが発生しました: ${message}`);
    }
  }

  /**
   * GET /csv-io/export
   * 指定コンテンツタイプのデータを CSV としてダウンロードする。
   *
   * Query Parameters:
   *   - contentType (required): 対象コンテンツタイプ UID
   *   - locale (optional): ロケール
   *   - excludeFields (optional): 除外フィールド（カンマ区切り）
   *     例: excludeFields=documentId,createdAt,updatedAt
   */
  async export(ctx: KoaContext): Promise<void> {
    const validation = this.validator.validateExportRequest(ctx);

    if (!validation.ok) {
      this.responseBuilder.buildValidationError(ctx, validation.message, validation.details);
      return;
    }

    const { options } = validation.value;

    try {
      const result = await this.csvService.exportCsv(options);
      this.responseBuilder.buildExportSuccess(
        ctx,
        result.data,
        result.mimeType,
        result.filename
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : '予期しないエラーが発生しました。';
      this.logger.error('[csv-import-export] Export failed:', err);
      this.responseBuilder.buildServerError(ctx, `エクスポート処理中にエラーが発生しました: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Strapi Plugin Controller ファクトリ
// Strapi v5 のプラグインコントローラー規約に準拠
// ---------------------------------------------------------------------------

/**
 * Strapi がプラグインコントローラーとして登録するファクトリ関数。
 *
 * Service を DI で受け取り、CsvController を生成して
 * Strapi に必要なメソッドマップとして返す。
 *
 * @example
 * // server/index.ts 内での登録例
 * import csvControllerFactory from './controllers/csv-controller';
 * export default {
 *   controllers: { csvController: csvControllerFactory },
 * };
 */
const csvControllerFactory = ({
  strapi,
}: {
  strapi: {
    plugin: (name: string) => { service: (name: string) => ICsvIoService };
    log: ILogger;
  };
}) => {
  const csvService = strapi.plugin('csv-import-export').service('csvService') as ICsvIoService;
  const controller = new CsvController(csvService, strapi.log);

  // Strapi Controller はメソッドを直接エクスポートする必要がある
  return {
    import: (ctx: KoaContext) => controller.import(ctx),
    export: (ctx: KoaContext) => controller.export(ctx),
  };
};

export default csvControllerFactory;
