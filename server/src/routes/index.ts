/**
 * @file server/routes/index.ts
 * @description
 * Strapi 管理画面から叩くエンドポイント定義。
 *
 * すべてのルートは `type: 'admin'` を指定しており、
 * 管理画面の認証（Admin JWT）が必要。
 *
 * エンドポイント一覧:
 *  POST /api/csv-io/import  - CSV インポート
 *  GET  /api/csv-io/export  - CSV エクスポート
 *
 * ポリシーについて:
 *  - `isAuthenticated`: Strapi Admin 認証済みユーザーのみ許可
 *  - 追加の RBAC ポリシーが必要な場合は `policies` 配列に追加する
 *
 * ミドルウェアについて:
 *  - `rateLimit`: 連続エクスポートによるリソース過多を防ぐ（オプション）
 */

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface RouteConfig {
  policies?: string[];
  middlewares?: string[];
  /** ルート情報をドキュメントから除外する場合 true */
  auth?: boolean | { scope: string[] };
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handler: string;
  config: RouteConfig;
}

export interface PluginRoutes {
  type: 'admin' | 'content-api';
  routes: Route[];
}

// ---------------------------------------------------------------------------
// 管理画面向けルート定義
// ---------------------------------------------------------------------------

const adminRoutes: PluginRoutes = {
  type: 'admin',
  routes: [
    // ------------------------------------------------------------------
    // POST /api/csv-io/import
    // ------------------------------------------------------------------
    {
      method: 'POST',
      path: '/import',
      handler: 'csvController.import',
      config: {
        /**
         * policies:
         *  - 'plugin::csv-io.isFeatureEnabled': カスタムポリシー例（オプション）
         *
         * Strapi Admin では `isAuthenticated` ポリシーはグローバルに適用されるため
         * ここでは空配列で問題ない。追加のロール制限が必要な場合のみ設定する。
         */
        policies: [],
        middlewares: [],
      },
    },

    // ------------------------------------------------------------------
    // GET /api/csv-io/export
    // ------------------------------------------------------------------
    {
      method: 'GET',
      path: '/export',
      handler: 'csvController.export',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};

export default adminRoutes;
