import { useEffect, useState } from 'react';
import type {
  CodexConnectionTarget,
  CodexDiscoveryResult,
} from '../shared/types';
import { errorText, ReleApi } from './client';
import { Button, Notice, Status } from './ui';

export const automaticCodex: CodexConnectionTarget = {
  transport: 'proxy',
  executable: 'codex',
  endpoint: '',
};

export function codexTargetKey(target: CodexConnectionTarget): string {
  return JSON.stringify([target.transport, target.executable, target.endpoint]);
}

export function CodexDiscovery({
  api,
  value,
  onChange,
  disabled,
  refreshKey,
}: {
  api: ReleApi;
  value: string;
  onChange: (value: 'auto' | 'manual' | CodexConnectionTarget) => void;
  disabled: boolean;
  refreshKey: number;
}) {
  const [discovery, setDiscovery] = useState<CodexDiscoveryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDiscovery(null);
    setLoading(true);
    setError('');
    void api
      .request<CodexDiscoveryResult>(
        '/api/codex/discovery',
        'GET',
        undefined,
        controller.signal,
      )
      .then(
        (result) => {
          if (!controller.signal.aborted) {
            setDiscovery(result);
            setLoading(false);
          }
        },
        (cause) => {
          if (!controller.signal.aborted) {
            setError(errorText(cause));
            setLoading(false);
          }
        },
      );
    return () => controller.abort();
  }, [api, revision, refreshKey]);
  const sources = {
    'desktop-process': 'Процесс Codex Desktop',
    'desktop-install': 'Установка Codex Desktop',
    path: 'Команда в PATH',
    standard: 'Стандартный каталог',
  };
  return (
    <fieldset className="codex-discovery">
      <legend>Выбор Codex</legend>
      <label className="check-row">
        <input
          type="radio"
          name="codex-target"
          checked={value === 'auto'}
          disabled={disabled}
          onChange={() => onChange('auto')}
        />
        <span>
          <strong>Находить Codex автоматически</strong>
          <small>
            Rele проверит доступные установки и выберет подходящее локальное
            подключение.
          </small>
        </span>
      </label>
      <div className="section-heading discovery-heading">
        <h3>Найдено на этом компьютере</h3>
        <Button
          icon="refresh"
          busy={loading}
          disabled={disabled}
          onClick={() => setRevision((current) => current + 1)}
        >
          Повторить поиск
        </Button>
      </div>
      {loading && (
        <p className="field-hint" role="status">
          Ищем установку и запущенный процесс Codex…
        </p>
      )}
      {error && <Notice>{error}</Notice>}
      {discovery && !discovery.installations.length && (
        <Notice tone="info">
          Локальная установка Codex не найдена. Откройте установленный Codex
          Desktop или установите Codex CLI и повторите поиск. Путь и адрес
          существующего сервера также можно указать вручную.
        </Notice>
      )}
      {!!discovery?.installations.length && (
        <div className="discovery-options">
          {discovery.installations.map((installation, index) => {
            const connection = installation.connection;
            const recommended =
              connection &&
              discovery.recommended &&
              codexTargetKey(connection) ===
                codexTargetKey(discovery.recommended);
            return (
              <label
                className="check-row discovery-option"
                key={`${installation.executable}:${installation.processId ?? index}`}
              >
                <input
                  type="radio"
                  name="codex-target"
                  checked={!!connection && value === codexTargetKey(connection)}
                  disabled={disabled || !connection}
                  onChange={() => connection && onChange(connection)}
                />
                <span>
                  <strong>{installation.name}</strong>
                  <small className="discovery-path">
                    {installation.executable}
                  </small>
                  <small>
                    {sources[installation.source]} ·{' '}
                    {installation.version
                      ? `CLI: ${installation.version}`
                      : 'Версия CLI не определена'}
                    {installation.running ? ' · Процесс запущен' : ''}
                  </small>
                  {connection?.endpoint && (
                    <small className="discovery-path">
                      {connection.transport === 'websocket'
                        ? 'WebSocket'
                        : 'Локальный сокет'}
                      : {connection.endpoint}
                    </small>
                  )}
                  {recommended && <Status tone="good">Рекомендуется</Status>}
                  {!connection && (
                    <small>
                      Подключение не определено. Проверьте сообщение ниже или
                      укажите параметры вручную.
                    </small>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {discovery?.issues.map((issue, index) => (
        <Notice key={`${issue.code}:${index}`} tone="warning">
          {issue.message}
          {issue.executable && (
            <div className="discovery-path">{issue.executable}</div>
          )}
        </Notice>
      ))}
      <p className="field-hint">
        Найденный файл и версия CLI ещё не подтверждают подключение к серверу.
        Фактический сервер показан выше после соединения. Если вариантов
        несколько, выберите нужный.
      </p>
      <label className="check-row">
        <input
          type="radio"
          name="codex-target"
          checked={value === 'manual'}
          disabled={disabled}
          onChange={() => onChange('manual')}
        />
        <span>
          <strong>Указать параметры вручную</strong>
          <small>
            Путь к исполняемому файлу, локальный сервер или WebSocket.
          </small>
        </span>
      </label>
    </fieldset>
  );
}
