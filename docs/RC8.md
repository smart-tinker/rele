# Rele 0.1.0-rc.8

Slack использует Agent Sessions и штатную кнопку Stop:

- `agents.sessions.setStatus`: `processing` только при выполнении запроса или распознавании аудио; `suspended` при ожидании подтверждения или ответа; `active` при ожидании запуска, неопределённости и после завершения. Выход из `processing` задаётся явно, включая после отправки финального ответа.
- `agent_session_stopped` проходит существующий durable механизм отмены с проверкой исходных account, channel, thread и отправителя. Receipt сохраняется до действия; повтор не отменяет запрос дважды. Событие не запускает модель и не добавляется в Slack-транскрипт. Запоздавший Stop не превращается в новую задачу и не отменяет последующие или ещё локально queued запросы. Смешанный ход автоматически не прерывается.
- Обычные команды `rele:cancel` в Slack и `/rele_cancel` в Telegram сохраняются, в том числе для собственного ожидающего запроса.

## Настройка Slack app

Новый [manifest](../integrations/slack-manifest.json) объявляет `features.agent_view.agent_description`, запрашивает `assistant:write` и `chat:write` и подписывается на `agent_session_stopped`. Без этой подписки штатный Stop недоступен; Rele показывает диагностику, продолжая задачу. Одного обновления Rele недостаточно.

Существующие приложения обновляются вручную с сохранением прежних scopes/events и уже включённого `assistant_view`. Переход на `agent_view` ради Stop не обязателен; Rele не выполняет необратимую миграцию поверхности автоматически. Для ещё не объявленного агентом бота оператор отдельно включает Agent feature и проверяет изменение messaging experience. При новых scopes нужна явная переавторизация установки. Токены вводятся только в закрытые поля настройки, не в чат. Подробности: [подключение Slack](CHANNELS.md#slack), [официальные правила миграции](https://docs.slack.dev/ai/migrating-to-agent-messaging/).

## Режимы и границы

Ubuntu Server без Desktop остаётся самостоятельным режимом: Rele запускает свой Codex через managed stdio, без GUI и настроенного WebSocket endpoint. Для одновременной работы с открытым Desktop оба клиента должны использовать один общий локальный app-server и исходный профиль. Обновление Rele само не настраивает запуск Desktop. Исходные threadId, история и ACL сохраняются; SQLite остаётся v4, проверяемые Codex — 0.163.0 и 0.163.0-alpha.10.2.

Точный spinner в обычных Activity/Threads и внешний вид штатного Stop требуют проверки настоящего Slack client. Этот RC не объявляет их исправленными по результатам одних API-вызовов. Живая приёмка rc.8 на рабочем Windows и управление с телефона не подтверждены; условия остаются открытыми в [ACCEPTANCE.md](ACCEPTANCE.md). Исторические результаты rc.7 не заменяют эту приёмку.

Контракты Slack: [Agent Sessions](https://docs.slack.dev/ai/agent-sessions/), [setStatus](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/), [Stop event](https://docs.slack.dev/reference/events/agent_session_stopped/).
