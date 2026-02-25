/**
 * @file admin/src/pages/App.tsx
 * @description
 * CSV Import/Export プラグインのメインページ。
 *
 * Import タブ: CSV ファイルをアップロードして指定コンテンツタイプへインポート
 * Export タブ: 指定コンテンツタイプのデータを CSV としてダウンロード
 */

import * as React from 'react';
import { useIntl } from 'react-intl';

import { Alert, Box, Button, Field, Flex, TextInput, Tabs, Typography } from '@strapi/design-system';
import { useAuth, Layouts, useFetchClient, useNotification } from '@strapi/strapi/admin';

import { getTranslation } from '../utils/getTranslation';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

interface ImportResult {
  data: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  errors?: Array<{ row: number; message: string }>;
  meta: { total: number };
}

// ---------------------------------------------------------------------------
// Import タブ
// ---------------------------------------------------------------------------

function ImportTab() {
  const { formatMessage } = useIntl();
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [contentType, setContentType] = React.useState('');
  const [idField, setIdField] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!contentType.trim()) {
      setError(formatMessage({ id: getTranslation('app.import.error.contentType.required') }));
      return;
    }
    if (!file) {
      setError(formatMessage({ id: getTranslation('app.import.error.file.required') }));
      return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('files', file);

      const params = new URLSearchParams({ contentType: contentType.trim() });
      if (idField.trim()) params.set('idField', idField.trim());

      // Content-Type ヘッダーを明示しないことで
      // ブラウザが multipart/form-data + boundary を自動設定する
      const response = await post<ImportResult>(
        `/csv-import-export/import?${params.toString()}`,
        formData
      );

      const data = response.data;
      setResult(data);
      toggleNotification({
        type: data.data.failed > 0 ? 'warning' : 'success',
        message: formatMessage(
          { id: getTranslation('app.import.notification.success') },
          { total: data.meta.total }
        ),
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : formatMessage({ id: getTranslation('app.error.unknown') });
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <Box tag="form" onSubmit={handleSubmit} padding={6}>
      <Flex direction="column" gap={4}>
        <Field.Root name="contentType" required>
          <Field.Label>
            {formatMessage({ id: getTranslation('app.import.label.contentType') })}
          </Field.Label>
          <TextInput
            placeholder="api::article.article"
            value={contentType}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setContentType(e.target.value)
            }
          />
          <Field.Hint>
            {formatMessage({ id: getTranslation('app.import.hint.contentType') })}
          </Field.Hint>
        </Field.Root>

        <Field.Root name="idField">
          <Field.Label>
            {formatMessage({ id: getTranslation('app.import.label.idField') })}
          </Field.Label>
          <TextInput
            placeholder="slug"
            value={idField}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setIdField(e.target.value)
            }
          />
          <Field.Hint>
            {formatMessage({ id: getTranslation('app.import.hint.idField') })}
          </Field.Hint>
        </Field.Root>

        <Box>
          <Typography variant="pi" fontWeight="bold" textColor="neutral800">
            {formatMessage({ id: getTranslation('app.import.label.file') })}
          </Typography>
          <Box marginTop={1}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv,application/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Box>
          {file && (
            <Typography variant="omega" textColor="neutral600">
              {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </Typography>
          )}
        </Box>

        {error && (
          <Alert
            variant="danger"
            title={formatMessage({ id: getTranslation('app.error.title') })}
            closeLabel="Close"
            onClose={() => setError(null)}
          >
            {error}
          </Alert>
        )}

        {result && (
          <Alert
            variant={result.data.failed > 0 ? 'warning' : 'success'}
            title={formatMessage({ id: getTranslation('app.import.result.title') })}
            closeLabel="Close"
            onClose={() => setResult(null)}
          >
            <Typography>
              {formatMessage(
                { id: getTranslation('app.import.result.summary') },
                {
                  total: result.meta.total,
                  created: result.data.created,
                  updated: result.data.updated,
                  skipped: result.data.skipped,
                  failed: result.data.failed,
                }
              )}
            </Typography>
            {result.errors && result.errors.length > 0 && (
              <Box marginTop={2}>
                {result.errors.map((e, i) => (
                  <Typography key={i} variant="omega" textColor="danger600">
                    Row {e.row}: {e.message}
                  </Typography>
                ))}
              </Box>
            )}
          </Alert>
        )}

        <Flex gap={2}>
          <Button
            type="submit"
            loading={isLoading}
            disabled={isLoading || !file || !contentType.trim()}
          >
            {formatMessage({ id: getTranslation('app.import.button.submit') })}
          </Button>
          {(result !== null || error !== null) && (
            <Button variant="tertiary" onClick={handleReset}>
              {formatMessage({ id: getTranslation('app.import.button.reset') })}
            </Button>
          )}
        </Flex>
      </Flex>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Export タブ
// ---------------------------------------------------------------------------

function ExportTab() {
  const { formatMessage } = useIntl();
  const { toggleNotification } = useNotification();
  // Strapi Admin の認証トークンを useAuth から安全に取得する
  const token = useAuth('ExportTab', (auth) => auth.token);

  const [contentType, setContentType] = React.useState('');
  const [excludeFields, setExcludeFields] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleExport = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!contentType.trim()) {
      setError(formatMessage({ id: getTranslation('app.export.error.contentType.required') }));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ contentType: contentType.trim() });
      if (excludeFields.trim()) params.set('excludeFields', excludeFields.trim());

      // useFetchClient は JSON レスポンスを前提とするため、
      // バイナリ(CSV)ダウンロードには標準 fetch + Bearer トークンを使用する
      const response = await fetch(`/csv-import-export/export?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token ?? ''}` },
      });

      if (!response.ok) {
        const json = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(
          json?.error?.message ??
            `HTTP ${response.status}: ${response.statusText}`
        );
      }

      // Content-Disposition ヘッダーからファイル名を取得
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const filenameMatch = /filename[^;=\n]*=["']?([^"';\n]+)["']?/.exec(disposition);
      const filename = filenameMatch?.[1]
        ? decodeURIComponent(filenameMatch[1])
        : `export_${contentType.trim().replace(/[^a-zA-Z0-9]/g, '_')}.csv`;

      // Blob URL を生成してダウンロードをトリガー
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      toggleNotification({
        type: 'success',
        message: formatMessage(
          { id: getTranslation('app.export.notification.success') },
          { filename }
        ),
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : formatMessage({ id: getTranslation('app.error.unknown') });
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box tag="form" onSubmit={handleExport} padding={6}>
      <Flex direction="column" gap={4}>
        <Field.Root name="contentType" required>
          <Field.Label>
            {formatMessage({ id: getTranslation('app.export.label.contentType') })}
          </Field.Label>
          <TextInput
            placeholder="api::article.article"
            value={contentType}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setContentType(e.target.value)
            }
          />
          <Field.Hint>
            {formatMessage({ id: getTranslation('app.export.hint.contentType') })}
          </Field.Hint>
        </Field.Root>

        <Field.Root name="excludeFields">
          <Field.Label>
            {formatMessage({ id: getTranslation('app.export.label.excludeFields') })}
          </Field.Label>
          <TextInput
            placeholder="documentId,createdAt,updatedAt,publishedAt"
            value={excludeFields}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setExcludeFields(e.target.value)
            }
          />
          <Field.Hint>
            {formatMessage({ id: getTranslation('app.export.hint.excludeFields') })}
          </Field.Hint>
        </Field.Root>

        {error && (
          <Alert
            variant="danger"
            title={formatMessage({ id: getTranslation('app.error.title') })}
            closeLabel="Close"
            onClose={() => setError(null)}
          >
            {error}
          </Alert>
        )}

        <Box>
          <Button
            type="submit"
            loading={isLoading}
            disabled={isLoading || !contentType.trim()}
          >
            {formatMessage({ id: getTranslation('app.export.button.submit') })}
          </Button>
        </Box>
      </Flex>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// App (メインページ)
// ---------------------------------------------------------------------------

function App() {
  const { formatMessage } = useIntl();

  return (
    <Layouts.Root>
      <Layouts.Header
        title={formatMessage({ id: getTranslation('plugin.name') })}
        subtitle={formatMessage({ id: getTranslation('plugin.description') })}
      />
      <Layouts.Content>
        <Tabs.Root defaultValue="import">
          <Tabs.List>
            <Tabs.Trigger value="import">
              {formatMessage({ id: getTranslation('app.tab.import') })}
            </Tabs.Trigger>
            <Tabs.Trigger value="export">
              {formatMessage({ id: getTranslation('app.tab.export') })}
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="import">
            <ImportTab />
          </Tabs.Content>

          <Tabs.Content value="export">
            <ExportTab />
          </Tabs.Content>
        </Tabs.Root>
      </Layouts.Content>
    </Layouts.Root>
  );
}

export { App };
