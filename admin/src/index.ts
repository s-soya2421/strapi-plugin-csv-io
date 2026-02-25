/**
 * @file admin/src/index.ts
 * @description
 * Strapi Admin Panel へのプラグイン登録エントリポイント。
 *
 * register():
 *   - サイドナビゲーションにリンクを追加
 *   - プラグインを Admin に登録
 *
 * registerTrads():
 *   - 翻訳ファイルを動的インポートで非同期ロード
 *   - ロケールごとにキーをプラグイン ID でプレフィックスして登録
 */

import type { StrapiApp } from '@strapi/strapi/admin';

import { PluginIcon } from './components/PluginIcon';
import { pluginId } from './pluginId';
import { getTranslation } from './utils/getTranslation';

const prefixTranslations = (
  trad: Record<string, string>,
  prefix: string
): Record<string, string> =>
  Object.fromEntries(Object.entries(trad).map(([key, value]) => [`${prefix}.${key}`, value]));

export default {
  register(app: StrapiApp) {
    app.addMenuLink({
      to: `/plugins/${pluginId}`,
      icon: PluginIcon,
      intlLabel: {
        id: getTranslation('plugin.name'),
        defaultMessage: 'CSV Import Export',
      },
      Component: () =>
        import('./pages/App').then((mod) => ({ default: mod.App })),
      permissions: [],
    });

    app.registerPlugin({
      id: pluginId,
      name: 'CSV Import Export',
    });
  },

  bootstrap(_app: StrapiApp) {},

  async registerTrads({ locales }: { locales: string[] }) {
    const importedTrads = await Promise.all(
      locales.map((locale) =>
        import(`./translations/${locale}.json`)
          .then(({ default: data }: { default: Record<string, string> }) => ({
            data: prefixTranslations(data, pluginId),
            locale,
          }))
          .catch(() => ({ data: {} as Record<string, string>, locale }))
      )
    );
    return importedTrads;
  },
};
