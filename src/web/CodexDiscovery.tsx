import { useEffect, useState } from 'react';
import type {
  CodexConnectionTarget,
  CodexDiscoveryResult,
  CodexTransport,
} from '../shared/types';
import { errorText, ReleApi } from './client';
import { Button, Notice, Status } from './ui';

export const automaticCodex: CodexConnectionTarget = {
  transport: 'shared',
  executable: 'codex',
  endpoint: '',
};

const externalConnectionIssues = new Set([
  'desktop-stdio',
  'desktop-listener-unsupported',
  'socket-not-found',
  'shared-socket-not-found',
  'default-socket-profile',
  'multiple-desktop-servers',
]);

export function codexTargetKey(target: CodexConnectionTarget): string {
  return JSON.stringify([target.transport, target.executable, target.endpoint]);
}

export function CodexDiscovery({
  api,
  value,
  onChange,
  disabled,
  refreshKey,
  transport,
}: {
  api: ReleApi;
  value: string;
  onChange: (value: 'auto' | 'manual' | CodexConnectionTarget) => void;
  disabled: boolean;
  refreshKey: number;
  transport: CodexTransport;
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
  const startsServer = transport === 'shared' || transport === 'managed';
  const recommended =
    transport === 'shared'
      ? discovery?.recommendedManaged && automaticCodex
      : startsServer
      ? discovery?.recommendedManaged && { ...discovery.recommendedManaged, transport }
      : discovery?.recommended?.transport === transport
        ? discovery.recommended
        : undefined;
  return (
    <fieldset className="codex-discovery">
      <legend>Выбор Codex</legend>
      {startsServer && (
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
              {transport === 'shared'
                ? 'Rele найдёт установленный Codex и общий сервер. При отсутствии сервера запустит штатный daemon Codex.'
                : 'Rele выберет подходящий Codex и запустит отдельный сервер.'}
            </small>
          </span>
        </label>
      )}
      <div className="section-heading discovery-heading">
        <h3>Найдено на этом компьютере</h3>
        <div className="discovery-actions">
          {recommended && (
            <Button
              disabled={disabled}
              onClick={() => onChange(recommended)}
            >
              Выбрать рекомендуемый
            </Button>
          )}
          <Button
            icon="refresh"
            busy={loading}
            disabled={disabled}
            onClick={() => setRevision((current) => current + 1)}
          >
            Повторить поиск
          </Button>
        </div>
      </div>
      {loading && (
        <p className="field-hint" role="status">
          Ищем установку и запущенный процесс Codex…
        </p>
      )}
      {error && <Notice>{error}</Notice>}
      {discovery && !discovery.installations.length && (
        <Notice tone="info">
          Локальная установка Codex не найдена. Установите Codex Desktop или
          Codex CLI и повторите поиск либо укажите путь вручную.
        </Notice>
      )}
      {!!discovery?.installations.length && (
        <div className="discovery-options">
          {discovery.installations.map((installation, index) => {
            const connection =
              startsServer
                ? installation.managedConnection && { ...installation.managedConnection, transport }
                : installation.connection?.transport === transport
                  ? installation.connection
                  : undefined;
            const isRecommended =
              connection &&
              recommended &&
              codexTargetKey(connection) ===
                codexTargetKey(recommended);
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
                  {connection && startsServer && (
                    <small>{transport === 'shared' ? 'Можно использовать для общего Codex' : 'Доступен для сервера Rele'}</small>
                  )}
                  {isRecommended && <Status tone="good">Рекомендуется</Status>}
                  {!connection && (
                    <small>
                      {startsServer
                        ? 'Запуск этого Codex не подтверждён. Проверьте сообщение ниже или укажите путь вручную.'
                        : 'Внешнее подключение этим способом не найдено. Укажите параметры вручную или выберите «Общий Codex».'}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {discovery?.issues
        .filter(
          (issue) =>
            transport !== 'managed' ||
            !externalConnectionIssues.has(issue.code),
        )
        .map((issue, index) => (
          <Notice key={`${issue.code}:${index}`} tone="warning">
            {issue.message}
            {issue.executable && (
              <div className="discovery-path">{issue.executable}</div>
            )}
          </Notice>
        ))}
      <p className="field-hint">
        {startsServer
          ? 'Это установленные версии Codex. Какая из них запущена для Rele, показано в фактическом подключении после сохранения.'
          : 'Найденный файл и версия CLI ещё не подтверждают соединение с существующим сервером. Фактическое подключение показано выше.'}
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
            {startsServer
              ? 'Путь к исполняемому файлу Codex.'
              : 'Путь к исполняемому файлу или адрес существующего сервера.'}
          </small>
        </span>
      </label>
    </fieldset>
  );
}
