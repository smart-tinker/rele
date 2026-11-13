# Выпуск Rele: draft → RC → stable

Это канонический контракт переходов и разрешения выпуска. Рабочий цикл —
[DEVELOPMENT](DEVELOPMENT.md), автоматические проверки и передача пакетов — [CI](CI.md),
native-приёмка — [ACCEPTANCE](ACCEPTANCE.md). Этот документ не разрешает dispatch,
публикацию, изменение настроек или установку вне согласованного scope.

Целевой репозиторий — [smart-tinker/rele](https://github.com/smart-tinker/rele).
Исторические теги и [заметки RC](RELEASE-HISTORY.md) не доказывают доступность
пакетов в его [Releases](https://github.com/smart-tinker/rele/releases).
Старый репозиторий не является источником пакетов нового выпуска.

## Состояния и версия

`draft` отвечает за публикацию, `prerelease` — за нестабильность. Флаги независимы.
Stable использует отдельный финальный тег; снятие `prerelease` у RC не создаёт
stable. Latest назначается только рекомендуемой стабильной версии.

| Состояние | Пример тега | draft | prerelease | Latest |
|---|---|---|---|---|
| Подготовка RC | `v0.1.2-rc.1` | true | true | нет |
| Опубликованный RC для тестирования | `v0.1.2-rc.1` | false | true | нет |
| Подготовка stable | `v0.1.2` | true | false | нет |
| Stable, не рекомендованный как Latest | `v0.1.2` | false | false | нет |
| Рекомендуемый stable | `v0.1.2` | false | false | да, по отдельному решению |

При публикации stable явно проверить выбор Latest (`make_latest` в API);
значение по умолчанию не является решением рекомендовать версию.

Новые кандидаты используют `vX.Y.Z-rc.N`; в `package.json` — `X.Y.Z-rc.N` без
`v`. По [SemVer](https://semver.org/#spec-item-11) числовой идентификатор даёт
`rc.9 < rc.10 < stable`; `N` — числовой идентификатор без ведущих нулей.
Строковая сортировка и формат `rc10` этот контракт не заменяют.
Исторические теги не переименовываются и не перемещаются.

Перед заморозкой проверить одновременно remote git-теги и Releases, включая
drafts под учётной записью с правом их читать. Отсутствие Release не означает
свободный тег. Read-only пример для выбранного кандидата:

```bash
git ls-remote --tags https://github.com/smart-tinker/rele.git 'refs/tags/v0.1.1-rc.*'
git ls-remote --tags https://github.com/smart-tinker/rele.git 'refs/tags/v0.1.1-rc.20' 'refs/tags/v0.1.1-rc.20^{}'
```

На проверке 2026-11-12 `v0.1.1-rc.19` занят, `v0.1.1-rc.20` отсутствует, Releases
пуст. Это снимок доступности имени, не резервирование и не разрешение выпуска.
Перед созданием кандидата проверку повторить; при ошибке доступа результат
`BLOCKED`, а не «тег свободен».

## Переходы и обязательные gates

| Этап | Что требуется | Что этап доказывает |
|---|---|---|
| Подготовка draft RC | Согласованный scope/issues, review, frozen source/build SHA; полный Windows/Linux набор [CI](CI.md#tdd-через-pr), штатные пакеты и provenance; release/identity guards [CI](CI.md#выпуск-и-бесплатные-лимиты) | Проверенные исходники и точные пакеты; draft ещё не распространён |
| Публикация RC | Draft прошёл сверку ниже; принятое соответствие `main`, свободное имя, полный комплект файлов, разрешение владельца проекта на распространение RC | `draft=false`, `prerelease=true`, не Latest; native-результаты и ограничения явно указаны |
| Приёмка RC | Готовые пакеты на согласованных Windows/Linux acceptance hosts по [DEVELOPMENT](DEVELOPMENT.md#рабочий-цикл) и [ACCEPTANCE](ACCEPTANCE.md) | Работа установленного приложения и выполнение критериев issues |
| Подготовка и публикация stable | RC принят; отдельное разрешение; финальная версия/тег, полные автоматические gates и native-приёмка финальных байтов, весь [ACCEPTANCE](ACCEPTANCE.md) без открытых обязательных критериев | `draft=false`, `prerelease=false`; Latest только для отдельно рекомендованной версии |

Быстрый draft PR не заменяет полную матрицу ready/main. Обязательны обе ОС и
aggregate `CI gate`, даже если настройки GitHub позволяют merge без него.
Актуальный состав protocol/managed/shared, installer, browser/UI и voice gates
остаётся в [CI](CI.md) и workflow; новый список здесь не подменяет их.

До RC допускается ещё не выполненная native-приёмка, если это явно отражено
в ограничениях и разрешённом тестовом распространении. Перед stable нужны
фактические Windows Desktop GUI/SID/ACL/DPAPI в интерактивной сессии владельца,
Linux systemd/reboot/recovery, реальные Telegram/Slack и остальные применимые
критерии [ACCEPTANCE](ACCEPTANCE.md). Fixture с локальным provider, backend probe
и HTTP 200 не заменяют эти результаты. Приёмка использует готовые installers/
portable без исходников, dev-suite и пересборки на acceptance hosts.

Между проверкой пакета и его публикацией пересборки нет: передаются те же байты.
Изменение встроенной версии RC на stable создаёт новые байты; прежние хеши и
native PASS к ним не переносятся. Финальные пакеты проходят соответствующие
автоматические и native gates до публичного stable. Исправление опубликованного
RC получает новый `N`; исправление stable — новую финальную версию.

## Сверка перед публикацией и readback

Оператор сохраняет один актуальный блок evidence в PR/release notes:

- Версия и канал, repository, tag и фактический commit, на который он указывает.
  Для annotated tag раскрыть tag object до commit. `target_commitish` не заменяет
  проверку git ref: при существующем теге GitHub его игнорирует. Если draft ещё
  не материализовал тег, записать это явно и проверить реальный ref при публикации;
  до readback соответствие тега не считается `PASS`.
- Source SHA, build SHA и связь с принятым кодом `main`. При различии SHA указать
  причину и проверить соответствие; не переносить CI PASS с одного SHA на другой.
  Текущий CI publisher требует точный build SHA текущего `main`.
- Точный CI run URL/ID, attempt, commit, обе OS jobs и `CI gate`; версии
  инструментов и Codex, методы и результаты проверок. Разные attempts не смешиваются.
- Полный inventory имён, размеров и SHA256: Linux `.deb` и `.tar.gz`, Windows
  `-setup.exe` и `.zip`, четыре `.sha256`, provenance `verification.json`.
  Проверить контрольные файлы, provenance и фактически загруженные assets.
  До признания draft проверенным финализатор обязан подтвердить attestations каждого входного
  файла от build job в `verify.yml` для этого repository, source SHA и main ref.
  `verification.json` объединяет проверенные отчёты обеих ОС, но сам не является
  подписанным build artifact. В assets также сохраняются два attested отчёта
  `linux-evidence.json` и `windows-evidence.json`; итоговый inventory — 11 файлов.
  Автоматические source archives GitHub не являются installer/portable.
- Отдельные результаты source/CI, package, installed runtime и real delivery;
  native acceptance, принятые критерии issues, известные ограничения и открытые DoD.
- Кто разрешил переход, когда и в каких границах: draft, публичный RC, stable,
  Latest и rollout различаются. Указать ответственного оператора и ссылку на решение.

Статусы: `PASS` — есть evidence на проверенные байты; `FAIL` — проверка выполнена
и не прошла; `UNRUN` — не запускалась; `BLOCKED` — препятствие не даёт выполнить;
`INVALID` — результат неприменим к этому SHA/среде; `N/A` — неприменимость объяснена.
Отсутствие результата не считается `PASS`.

После создания draft сверить его ID, флаги, pinned target, точный набор assets и
SHA256 с inventory. После разрешённой публикации повторно прочитать Release,
реальный tag commit, флаги/Latest и хеши опубликованных файлов. При несовпадении
остановить распространение; повторная отправка или замена файлов не исправляет
evidence автоматически. CI run и его `verification.json` подтверждают происхождение
байтов, но не утверждают manual/native acceptance.

## Что уже делает tooling

Контракт сверён с [оркестрацией CI](../.github/workflows/ci.yml),
[общей матрицей](../.github/workflows/verify.yml),
[package](../scripts/package.mjs), [Windows installer](../scripts/build-windows-installer.mjs),
[Linux installer](../scripts/build-linux-installer.mjs),
[CI contract](../scripts/ci-contract.mjs) и [publisher](../scripts/ci-publish.mjs).

- Package builders принимают финальную версию или `X.Y.Z-rc.N`; Windows
  ограничивает числовые компоненты 65535, Debian преобразует `-rc.` в `~rc.`.
  Поддержку финальной версии builder-ом нельзя выдавать за готовый stable flow.
- Подготовительный job создаёт новый непроверенный draft с pinned source/run/attempt.
  Это незавершённая подготовка, не готовый кандидат для распространения.
- Release build job создаёт GitHub artifact attestations для точных пакетов,
  контрольных файлов и `evidence.json`, затем загружает их прямо в тот же draft. Обычные PR/main
  runs не подписывают и не загружают пакеты. Publisher сначала проверяет repository,
  signer workflow `verify.yml`, source SHA/main ref и GitHub-hosted runner origin.
  Уникальные remote имена OS-отчётов при скачивании возвращаются в локальное
  `evidence.json` без изменения подписанных байтов.
- CI bundle/publisher принимают только RC, связывают обе ОС с одним SHA/run/attempt,
  проверяют файлы и SHA256, отклоняют занятые tag/release и изменившийся `main`.
  Ручной `release: true` из `main` оставляет `draft=true, prerelease=true`.
  После скачивания и проверки десяти исходных assets финализатор добавляет
  сводный `verification.json`, отмечает draft проверенным и делает readback.
  Пакеты повторно не загружаются и не пересобираются.
- Actions artifacts, их квота, retention и удаление transfers в выпуске не используются.
  Старые данные, теги и Releases не меняются. Неопределённый ACK, частичный upload
  или ошибка проверки оставляют draft для сверки; существующие assets не
  перезаписываются, шаги автоматически не повторяются.
- Автоматическая публикация RC/stable, назначение Latest и проверка native-приёмки
  не реализованы. Publisher задаёт `target_commitish`, но не делает независимый
  readback реального tag commit после публикации. Это обязательные операторские
  проверки, а их автоматизация — отдельная задача. Неподдерживаемые stable-команды
  или обход RC guard не используются.

## Полномочия и остановка

Владелец проекта разрешает публичный RC и отдельно stable/rollout
в согласованном scope; оператор выполняет переход и фиксирует evidence.
Право записи GitHub, green CI, merge и наличие этого документа разрешение
не заменяют. Не менять permissions, billing или release-настройки ради прохождения.

Остановить следующий переход при занятом имени, неподтверждённом tag/SHA,
неполном комплекте или неверных хешах/provenance, незавершённом обязательном gate,
смене `main`, неподтверждённой идентичности draft, отсутствии разрешения или реальном отказе контроля.
Перед stable останавливает также открытая обязательная native-приёмка. Спорное
снижение требований выносится на отдельное решение, без ослабления текущих gates.

Опубликованные теги и файлы не перемещаются и не перезаписываются. Частичный,
неудачный или заменённый draft сохранить с явной причиной и ссылкой на замену;
автоматически не удалять и не публиковать. После потерянного ACK сначала сверить
Release/tag/assets и receipts, затем определить разрешённый следующий шаг.

Основания: [GitHub release management](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository),
[Release API](https://docs.github.com/en/rest/releases/releases#create-a-release),
[SemVer](https://semver.org/). GitHub допускает разные операции; ограничения выше
являются контрактом Rele.
