# strapi-plugin-csv-import-export

Strapi v5 向けの CSV インポート / エクスポートプラグイン。

## 機能

- 管理画面 API 経由で CSV ファイルをインポート（新規作成 / upsert）
- コンテンツタイプのデータを CSV ファイルとしてエクスポート
- ロケール対応
- 10 MB までのファイルサイズ制限
- 部分失敗時の詳細なエラーレポート

## 要件

- Strapi v5
- Node.js 18 以上

## インストール

```bash
npm install strapi-plugin-csv-import-export
```

`config/plugins.ts`（または `config/plugins.js`）でプラグインを有効化します。

```ts
export default {
  'csv-import-export': {
    enabled: true,
  },
};
```

## API エンドポイント

すべてのエンドポイントは管理画面の認証（Admin JWT）が必要です。

### CSV インポート

```
POST /api/csv-import-export/import
```

`multipart/form-data` で CSV ファイルをアップロードします。

**クエリパラメータ**

| パラメータ | 必須 | 説明 |
|---|---|---|
| `contentType` | ✓ | 対象コンテンツタイプの UID（例: `api::article.article`） |
| `locale` | | ロケール識別子（例: `ja`） |
| `idField` | | upsert 時にレコードを同定するフィールド名。指定すると既存レコードは更新、未存在レコードは作成される。未指定の場合は常に新規作成。 |

**フォームフィールド**

アップロードファイルのフィールド名は `files`、`file`、または `csv` を使用してください。

**許可される MIME タイプ**

- `text/csv`
- `application/csv`
- `application/octet-stream`

**リクエスト例（curl）**

```bash
# 常に新規作成
curl -X POST "http://localhost:1337/api/csv-import-export/import?contentType=api::article.article" \
  -H "Authorization: Bearer <admin-jwt>" \
  -F "files=@articles.csv"

# title フィールドで既存レコードを更新（upsert）
curl -X POST "http://localhost:1337/api/csv-import-export/import?contentType=api::article.article&idField=title" \
  -H "Authorization: Bearer <admin-jwt>" \
  -F "files=@articles.csv"
```

**レスポンス例（成功）**

```json
{
  "data": {
    "created": 5,
    "updated": 2,
    "skipped": 0,
    "failed": 0
  },
  "meta": {
    "total": 7
  }
}
```

**レスポンス例（一部失敗 — HTTP 207）**

```json
{
  "data": {
    "created": 4,
    "updated": 1,
    "skipped": 0,
    "failed": 2
  },
  "errors": [
    { "row": 3, "message": "title は必須フィールドです。" },
    { "row": 6, "message": "無効な日付フォーマット: '2024/13/01'" }
  ],
  "meta": {
    "total": 7
  }
}
```

---

### CSV エクスポート

```
GET /api/csv-import-export/export
```

指定したコンテンツタイプの全レコードを CSV ファイルとしてダウンロードします。

**クエリパラメータ**

| パラメータ | 必須 | 説明 |
|---|---|---|
| `contentType` | ✓ | 対象コンテンツタイプの UID（例: `api::article.article`） |
| `locale` | | ロケール識別子（例: `ja`） |
| `excludeFields` | | 除外するフィールド名（カンマ区切り）。例: `documentId,createdAt,updatedAt` |

**リクエスト例（curl）**

```bash
# 全フィールドをエクスポート
curl "http://localhost:1337/api/csv-import-export/export?contentType=api::article.article" \
  -H "Authorization: Bearer <admin-jwt>" \
  -o articles.csv

# Strapi 管理フィールドを除外してエクスポート
curl "http://localhost:1337/api/csv-import-export/export?contentType=api::article.article&excludeFields=documentId,createdAt,updatedAt,publishedAt" \
  -H "Authorization: Bearer <admin-jwt>" \
  -o articles.csv
```

**レスポンス**

`Content-Disposition: attachment` 付きの CSV ファイル（`text/csv; charset=utf-8`）が返ります。ファイル名は `export_<contentType>_<timestamp>.csv` 形式です。

---

## CSV フォーマット

- 1 行目をヘッダー行として扱います。
- BOM 付き UTF-8 に対応しています。
- 数値・boolean は自動キャストされます。
- `null` / `undefined` はエクスポート時に空文字列として出力されます。
- オブジェクト型フィールドはエクスポート時に JSON 文字列としてシリアライズされます。

**インポート用 CSV の例（articles）**

```csv
title,content,publishedAt
"はじめての Strapi","Strapi は Node.js 製の CMS です。",
"CSV プラグイン入門","CSV で一括登録できます。",
```

---

## 開発

```bash
# 依存パッケージのインストール
npm install

# TypeScript ビルド
npm run build

# テスト実行
npm test

# テスト（ウォッチモード）
npm run test:watch

# カバレッジ計測
npm run test:coverage
```

### テスト構成

| ファイル | 種別 | テスト数 |
|---|---|---|
| `server/controllers/csv-controller.test.ts` | 単体テスト | 12 |
| `server/services/csv-service.test.ts` | 単体テスト | 22 |
| `server/integration/csv-import-export.integration.test.ts` | 統合テスト | 9 |

### アーキテクチャ

SOLID 原則に基づいた Strategy / Repository / Facade パターンを採用しています。

```
Controller (csv-controller.ts)
  └── ICsvIoService
        ├── CsvIoService (Facade)
        │     ├── DataImporter  ← IDocumentRepository
        │     ├── DataExporter  ← IDocumentRepository
        │     ├── CsvImportStrategy (csv-parse)
        │     └── CsvExportStrategy (csv-stringify)
        └── StrapiDocumentRepository (Strapi Document API)
```

- `IDocumentRepository` で Strapi Document API を抽象化し、テスト時は `InMemoryDocumentRepository` に差し替え可能です。
- `IImportStrategy` / `IExportStrategy` を実装するだけで、JSON や Excel などの新フォーマットを追加できます（Open/Closed 原則）。

## ライセンス

MIT
