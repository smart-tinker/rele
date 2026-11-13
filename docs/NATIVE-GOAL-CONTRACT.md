# Native Goal: проверенный контракт и граница issue #1

Проверено 12 ноября 2026 на официальных Linux x64 пакетах Codex. Это
изолированная protocol-проверка, не приёмка установленного приложения или Slack.

| Версия | SHA256 бинарника | Lifecycle / первый approval |
|---|---|---|
| `0.167.0-alpha.4.1` | `c3dea068c8794f1764051c1fd182ff0524352bbddf2f2638e72386b9b7b74368` | PASS / Goal-привязки ещё нет |
| `0.167.0-alpha.4.3` | `d165372a55d72da41f5d585513d7bf6bee14c92ac4f7573070ab68a1becb3584` | PASS / Goal-привязки ещё нет |
| `0.167.2` — stable | `a9672d0fa0dd8fcf8cad136fa0d056b914bc046f5ac3d78f4a5cf390655af56b` | PASS / Goal-привязки ещё нет |
| `0.170.0-alpha.2` — latest alpha | `faa565d94e78c7ecfcfe7d9f3c05d7601174ce9d82299356eda7a830676d47dd` | PASS / Goal-привязки ещё нет |

Архивы проверены по SHA512 из metadata `registry.npmjs.org/@openai/codex`.
Для каждой версии её же бинарник генерировал экспериментальную TypeScript
схему. Релевантные Goal/Turn/Timeline/ThreadExtra схемы совпали. Контрольные SHA256:

| Файл схемы | SHA256 |
|---|---|
| `v2/ThreadGoal.ts` | `c06ffa09651d4cc7f66dc6c0c2ea8f94551c10c1837aa3f73b7b66def1faaf7c` |
| `v2/ThreadGoalSetParams.ts` | `0f6628f08fbe8b2adc0b4cab51d3e4728b41cccfeb2a4b005214efa71c6bc08e` |
| `v2/ThreadGoalUpdatedNotification.ts` | `a01a94c0dee5c68ae076b6950ecfa9acac1cc8a79718dde1a2a5a7ef26577a6c` |
| `v2/Turn.ts` | `6ca94cbd4890035e943056cac6d6d910285a412e34545697780d85993819a28f` |
| `v2/ThreadTimelineEntry.ts` | `4d917b865b81ea61f9b3cee7400fd15fc3af0908ddb60d60c858b1c7abf9c148` |

## Воспроизведение и наблюдения

[Probe](../scripts/probe-native-goals.mjs) и [opt-in тест](../tests/native-source-controls.test.ts)
создают новый временный `CODEX_HOME`, новый fixture thread и loopback Responses
provider. Пользовательский профиль, auth и credentials не читаются. Внешних
или платных inference-запросов — **0**, обычных `turn/start` — **0**.

```sh
RELE_NATIVE_GOALS_CLI=/absolute/path/to/isolated/codex \
RELE_NATIVE_GOALS_VERSION=0.170.0-alpha.2 \
npm test -- tests/native-source-controls.test.ts
```

Каждый запуск сохраняет `result.json`, generated schema и упорядоченный trace
в своём `--directory`; бинарник не устанавливается в пользовательский runtime.
Сводный операторский artifact — `native-goals-version-matrix.json` в отдельном
каталоге `issue1-native-tools` рядом с рабочим checkout. Production allowlist
и native runtime этой проверкой не менялись.

На всех четырёх версиях:

1. `initialize` с experimental API → `thread/start` →
   `thread/goal/set {origin:"user", objective, tokenBudget}` →
   `thread/goal/get`: native цель существует, обычный prompt не отправлен.
2. Native начинает автономный ход (`turn/started`). В первом fixture response
   возвращается вызов `exec_command`, требующий подтверждения.
3. Приходит настоящий `item/commandExecution/requestApproval` с `threadId` и
   `turnId`. `thread/goal/updated` с этим `turnId` ещё отсутствует.
4. Approval удерживается 300 мс. Goal-привязка за это время не появляется.
5. Fixture явно отклоняет команду. Native command receipt: `declined`,
   `processId:null`, `exitCode:null`; **команда не исполнена**.
6. После отклонения/завершения command item приходит Goal accounting update
   с `turnId`. Для обычного unpaused публичного этапа accounting update
   появляется после agentMessage item, перед `turn/completed`.

Также подтверждены native completion и сохранение Goal после restart/resume.
`status:"paused"` останавливает будущие продолжения, но **не прерывает активный
ход**. Для paused-in-flight этапа turn-linked Goal update не появился.

Публичные схемы не содержат Goal ID или Goal-поля в Turn. На stable и latest
alpha во время ожидающего approval `thread/read` вернул `extra:null` и
`status:{type:"active", activeFlags:["waitingOnApproval"]}`. Timeline содержал
`turnStarted` без Goal-привязки. Его cursor — пагинация истории, а не replay
notification events.

## Почему одной задержки approval недостаточно

В проверенной последовательности связь стала известна после решения по
approval. Rele не может одновременно ждать этой связи и гарантированно
обработать первый approval через исходный Slack-тред. 300 мс не доказывают
невозможность произвольного более позднего события; однако проверенный контракт
не гарантирует нужный порядок. Присвоение хода по времени, тексту objective или
отсутствию userMessage не даёт гарантии происхождения в общем Codex-чате.
После полностью пропущенного события та же проблема остаётся в истории.

## Граница поддержки Rele

Issue #1 не требует пересылать каждый первый native approval именно в Slack
или безошибочно приписывать полностью пропущенные события. В общем подключении
с доступным native UI такие вопросы остаются в Codex. Форма Rele заранее
предупреждает об этом. Правила подтверждения не расширяются.

В режиме «Сервер Rele» managed child отклоняет запросы без подтверждённого
происхождения и не имеет отдельного native UI для ответа. Поэтому новый Goal
launch в managed недоступен с явной причиной. Status, Model, чтение существующей
Goal и адресная приостановка сохраняются. Режим автоматически не меняется.

После перерыва подписки, неизвестной доставки или завершённого хода без native
Goal-привязки Rele сохраняет видимое UNCERTAIN. Оно не исчезает от следующего
пустого окна истории. Native complete и полнота доставки показываются отдельно:
при неизвестной доставке возможна карточка native состояния, но нет подтверждения
полной доставки и её итогового закрытия. Неизвестные ходы не приписываются цели
по времени или тексту и не отправляются повторно.

Завершённый native owner снимается с новых событий до создания следующей цели;
его прежний outbox сохраняется. Если новый native ACK вернул публичную
идентичность, совпадающую с сохранённой целью, автоматическая атрибуция
изолируется и показывается UNCERTAIN. Это исключает отправку результата новой
цели в старый Slack-источник даже при одинаковом objective и timestamp.

Поддерживаемый shared/native-UI сценарий использует настоящий Goals API,
сохранённый origin/outbox, отдельную хронологическую доставку публичных этапов и
существующие подтверждения Rele для доказанных ходов. Сохранённые квитанции и
известные turn IDs восстанавливаются без повторного thread/goal/set. Отдельные
внешние проверки Slack desktop/mobile и штатных пакетов остаются этапом приёмки.

## Возможное дополнение native API

Для более сильной гарантии всех режимов без native UI были бы полезны:

- Устойчивый Goal ID и авторитетная привязка goalId в turn/started до вопросов,
  approvals и публичных items этого хода.
- Тот же goalId в сохранённой истории каждого native turn для восстановления
  после reconnect/restart без inference и повторного запуска.

Это предложение дополнительного контракта, не обязательное условие shared
сценария issue #1. Отдельная ролевая модель, upstream публикация, native production
patch и молчаливое сужение пользовательского scope не добавлены.
