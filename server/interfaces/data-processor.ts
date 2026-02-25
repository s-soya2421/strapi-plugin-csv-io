/**
 * @file data-processor.ts
 * @description
 * プラグイン全体で使用する汎用インターフェース群。
 *
 * 設計方針:
 *  - Open/Closed原則: IImportStrategy / IExportStrategy を実装するだけで
 *    新しいフォーマット（JSON, Excel 等）を追加でき、既存コードは無変更。
 *  - Dependency Inversion原則: IDocumentRepository を介して Strapi Document API を
 *    抽象化し、具体的な実装に依存しない。
 *  - Interface Segregation原則: インポート責務とエクスポート責務を分離。
 */

// ---------------------------------------------------------------------------
// Strapi Document 関連型
// ---------------------------------------------------------------------------

/** Strapi v5 Document の共通フィールド */
export interface StrapiDocument {
  documentId: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string | null;
  locale?: string | null;
  [key: string]: unknown;
}

/** strapi.documents() に渡せるクエリパラメータ */
export interface DocumentQueryParams {
  filters?: Record<string, unknown>;
  populate?: Record<string, unknown> | string[];
  fields?: string[];
  locale?: string;
  status?: 'draft' | 'published';
  pagination?: {
    page?: number;
    pageSize?: number;
    withCount?: boolean;
  };
  sort?: string | string[];
}

// ---------------------------------------------------------------------------
// インポート/エクスポート共通型
// ---------------------------------------------------------------------------

/** インポート失敗行の詳細 */
export interface ImportError {
  /** 0-indexed の行番号（ヘッダーを除く） */
  row: number;
  field?: string;
  message: string;
}

/** インポート処理の最終結果サマリー */
export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: ImportError[];
}

/** エクスポート処理の最終結果 */
export interface ExportResult {
  /** シリアライズ済みデータ（CSV文字列、バイナリ等） */
  data: string | Buffer;
  /** レスポンスヘッダー用 MIME タイプ */
  mimeType: string;
  /** 推奨ダウンロードファイル名 */
  filename: string;
}

// ---------------------------------------------------------------------------
// プロセッサーオプション
// ---------------------------------------------------------------------------

/** インポート/エクスポート時の共通オプション */
export interface ProcessorOptions {
  /** 対象コンテンツタイプ UID (例: 'api::article.article') */
  contentType: string;
  /** ロケール識別子 (例: 'ja') */
  locale?: string;
  /**
   * upsert 時にレコードを同定するフィールド名。
   * 指定された場合、既存レコードは更新・未存在レコードは作成される。
   * 未指定の場合は常に新規作成。
   */
  idField?: string;
  /**
   * エクスポート時に除外するフィールド名の配列。
   * 例: ['documentId', 'createdAt', 'updatedAt']
   */
  excludeFields?: string[];
}

// ---------------------------------------------------------------------------
// Strategy インターフェース (Open/Closed原則の核心)
// ---------------------------------------------------------------------------

/**
 * インポート戦略インターフェース。
 * 新しいフォーマットは、このインターフェースを実装したクラスを追加するだけでよい。
 * 既存の Service やコードは変更不要。
 *
 * @example
 * // JSON フォーマット対応を追加する場合
 * class JsonImportStrategy implements IImportStrategy { ... }
 */
export interface IImportStrategy {
  /** このストラテジーが受け付ける MIME タイプ一覧 */
  readonly mimeTypes: readonly string[];
  /** このストラテジーが受け付けるファイル拡張子一覧 (ドットなし) */
  readonly fileExtensions: readonly string[];

  /**
   * 生のファイルデータを、Strapi への登録に適したオブジェクト配列へ変換する。
   * @param input - アップロードされたファイルの Buffer または文字列
   * @param options - 処理オプション
   * @returns パース済みレコードの配列
   */
  parse(
    input: Buffer | string,
    options: ProcessorOptions
  ): Promise<Record<string, unknown>[]>;
}

/**
 * エクスポート戦略インターフェース。
 * 新しいフォーマット対応を追加する場合、このインターフェースを実装する。
 */
export interface IExportStrategy {
  /** このストラテジーが出力する MIME タイプ */
  readonly mimeType: string;
  /** このストラテジーが出力するファイル拡張子 (ドットなし) */
  readonly fileExtension: string;

  /**
   * Strapi Document の配列を指定フォーマットの文字列/バイナリへ変換する。
   * @param data - エクスポート対象ドキュメントの配列
   * @param options - 処理オプション
   * @returns ExportResult
   */
  format(
    data: StrapiDocument[],
    options: ProcessorOptions
  ): Promise<ExportResult>;
}

// ---------------------------------------------------------------------------
// Repository インターフェース (Dependency Inversion原則の核心)
// ---------------------------------------------------------------------------

/**
 * Strapi Document Service を抽象化したリポジトリインターフェース。
 * Service 層はこのインターフェースにのみ依存し、
 * Strapi の具体的な API には依存しない。
 */
export interface IDocumentRepository {
  /**
   * 複数ドキュメントを取得する。
   * @param contentType - コンテンツタイプ UID
   * @param params - クエリパラメータ
   */
  findMany(
    contentType: string,
    params?: DocumentQueryParams
  ): Promise<StrapiDocument[]>;

  /**
   * 条件に一致する最初のドキュメントを取得する。
   * @param contentType - コンテンツタイプ UID
   * @param params - クエリパラメータ
   */
  findFirst(
    contentType: string,
    params?: DocumentQueryParams
  ): Promise<StrapiDocument | null>;

  /**
   * 新規ドキュメントを作成する。
   * @param contentType - コンテンツタイプ UID
   * @param data - 登録データ
   * @param locale - ロケール
   */
  create(
    contentType: string,
    data: Record<string, unknown>,
    locale?: string
  ): Promise<StrapiDocument>;

  /**
   * 既存ドキュメントを更新する。
   * @param contentType - コンテンツタイプ UID
   * @param documentId - 対象ドキュメント ID
   * @param data - 更新データ
   * @param locale - ロケール
   */
  update(
    contentType: string,
    documentId: string,
    data: Record<string, unknown>,
    locale?: string
  ): Promise<StrapiDocument>;
}

// ---------------------------------------------------------------------------
// ユースケース インターフェース (Single Responsibility)
// ---------------------------------------------------------------------------

/**
 * インポートユースケースのインターフェース。
 * ストラテジーを受け取り、実際の登録処理を調整する。
 */
export interface IDataImporter {
  /**
   * @param rawData - アップロードされた生ファイルデータ
   * @param strategy - 使用するパースストラテジー
   * @param options - 処理オプション
   */
  import(
    rawData: Buffer | string,
    strategy: IImportStrategy,
    options: ProcessorOptions
  ): Promise<ImportResult>;
}

/**
 * エクスポートユースケースのインターフェース。
 * ストラテジーを受け取り、データ取得とシリアライズを調整する。
 */
export interface IDataExporter {
  /**
   * @param strategy - 使用するフォーマットストラテジー
   * @param options - 処理オプション
   */
  export(
    strategy: IExportStrategy,
    options: ProcessorOptions
  ): Promise<ExportResult>;
}

// ---------------------------------------------------------------------------
// プラグインサービス統合インターフェース
// ---------------------------------------------------------------------------

/**
 * Controller が依存するサービスの公開インターフェース。
 * 具体的な実装クラスではなく、このインターフェースに依存することで
 * テスト時のモック差し替えが容易になる。
 */
export interface ICsvIoService {
  /**
   * CSV ファイルを指定コンテンツタイプへインポートする。
   * @param fileBuffer - アップロードされた CSV ファイルの Buffer
   * @param options - 処理オプション
   */
  importCsv(fileBuffer: Buffer, options: ProcessorOptions): Promise<ImportResult>;

  /**
   * 指定コンテンツタイプのデータを CSV としてエクスポートする。
   * @param options - 処理オプション
   */
  exportCsv(options: ProcessorOptions): Promise<ExportResult>;
}

// ---------------------------------------------------------------------------
// ロガー インターフェース (Dependency Inversion)
// ---------------------------------------------------------------------------

/**
 * Controller / Service が依存するロガーの最小インターフェース。
 * Strapi の `strapi.log` はこのインターフェースを満たすため、
 * テスト時はモックに差し替えられる。
 */
export interface ILogger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// ストラテジーレジストリ インターフェース (拡張ポイント)
// ---------------------------------------------------------------------------

/**
 * MIME タイプや拡張子からストラテジーを解決するレジストリ。
 * プラグイン利用者がカスタムストラテジーを登録できる拡張ポイント。
 */
export interface IStrategyRegistry {
  registerImport(strategy: IImportStrategy): void;
  registerExport(strategy: IExportStrategy): void;
  resolveImport(mimeTypeOrExtension: string): IImportStrategy | null;
  resolveExport(mimeTypeOrExtension: string): IExportStrategy | null;
}
