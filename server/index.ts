/**
 * @file server/index.ts
 * @description
 * Strapi v5 プラグインのサーバーサイドエントリーポイント。
 * Controller / Service / Route を Strapi に登録する。
 */

import csvServiceFactory from './services/csv-service';
import csvControllerFactory from './controllers/csv-controller';
import adminRoutes from './routes';

export default {
  register() {},
  bootstrap() {},

  services: {
    csvService: csvServiceFactory,
  },

  controllers: {
    csvController: csvControllerFactory,
  },

  routes: {
    'csv-import-export': adminRoutes,
  },
};
