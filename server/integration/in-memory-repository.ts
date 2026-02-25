/**
 * @file in-memory-repository.ts
 * @description
 * 統合テスト用の IDocumentRepository インメモリ実装。
 *
 * Strapi Document API をインメモリのデータ構造でエミュレートする。
 * テスト時に StrapiDocumentRepository の代わりに注入して使う。
 *
 * サポートする機能:
 *  - findMany: locale / $eq フィルター / pagination
 *  - findFirst: findMany を1件に絞る
 *  - create: 連番 documentId を自動付与
 *  - update: 既存ドキュメントの部分更新
 *
 * テスト補助メソッド:
 *  - seed: 初期データ投入（documentId は自動生成）
 *  - getAllDocuments: ストアの全ドキュメント取得
 *  - clear: ストア全消去
 */

import type {
  IDocumentRepository,
  StrapiDocument,
  DocumentQueryParams,
} from '../interfaces/data-processor';

export class InMemoryDocumentRepository implements IDocumentRepository {
  /** contentType → documentId → StrapiDocument */
  private readonly store = new Map<string, Map<string, StrapiDocument>>();
  private idCounter = 0;

  // ---------------------------------------------------------------------------
  // IDocumentRepository 実装
  // ---------------------------------------------------------------------------

  async findMany(
    contentType: string,
    params: DocumentQueryParams = {}
  ): Promise<StrapiDocument[]> {
    let docs = Array.from(this.getContentStore(contentType).values());

    // locale フィルター
    if (params.locale) {
      docs = docs.filter((d) => d.locale === params.locale || d.locale == null);
    }

    // filters: { field: { $eq: value } } または { field: value } に対応
    if (params.filters) {
      for (const [key, condition] of Object.entries(params.filters)) {
        docs = docs.filter((d) => {
          if (
            condition !== null &&
            typeof condition === 'object' &&
            '$eq' in (condition as object)
          ) {
            return d[key] === (condition as { $eq: unknown })['$eq'];
          }
          return d[key] === condition;
        });
      }
    }

    // ページネーション
    if (params.pagination) {
      const { page = 1, pageSize = 100 } = params.pagination;
      const start = (page - 1) * pageSize;
      docs = docs.slice(start, start + pageSize);
    }

    return docs;
  }

  async findFirst(
    contentType: string,
    params: DocumentQueryParams = {}
  ): Promise<StrapiDocument | null> {
    const results = await this.findMany(contentType, {
      ...params,
      pagination: { page: 1, pageSize: 1 },
    });
    return results[0] ?? null;
  }

  async create(
    contentType: string,
    data: Record<string, unknown>,
    locale?: string
  ): Promise<StrapiDocument> {
    const store = this.getContentStore(contentType);
    const documentId = `doc-${++this.idCounter}`;
    const now = new Date().toISOString();

    const doc: StrapiDocument = {
      documentId,
      createdAt: now,
      updatedAt: now,
      locale: locale ?? null,
      ...data,
    };

    store.set(documentId, doc);
    return doc;
  }

  async update(
    contentType: string,
    documentId: string,
    data: Record<string, unknown>,
    locale?: string
  ): Promise<StrapiDocument> {
    const store = this.getContentStore(contentType);
    const existing = store.get(documentId);

    if (!existing) {
      throw new Error(`[InMemoryRepository] Document not found: ${documentId}`);
    }

    const updated: StrapiDocument = {
      ...existing,
      ...data,
      documentId,
      updatedAt: new Date().toISOString(),
      ...(locale !== undefined ? { locale } : {}),
    };

    store.set(documentId, updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // テスト補助メソッド
  // ---------------------------------------------------------------------------

  /**
   * 初期データを投入する。documentId は自動生成。
   * @returns 生成されたドキュメントの配列
   */
  seed(
    contentType: string,
    docs: Omit<StrapiDocument, 'documentId'>[]
  ): StrapiDocument[] {
    return docs.map((data) => {
      const documentId = `seeded-${++this.idCounter}`;
      const doc: StrapiDocument = { documentId, ...data };
      this.getContentStore(contentType).set(documentId, doc);
      return doc;
    });
  }

  /**
   * 指定コンテンツタイプの全ドキュメントを返す。
   */
  getAllDocuments(contentType: string): StrapiDocument[] {
    return Array.from(this.getContentStore(contentType).values());
  }

  /**
   * ストアを全て消去する（beforeEach での初期化用）。
   */
  clear(): void {
    this.store.clear();
    this.idCounter = 0;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getContentStore(contentType: string): Map<string, StrapiDocument> {
    if (!this.store.has(contentType)) {
      this.store.set(contentType, new Map());
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.store.get(contentType)!;
  }
}
