# Разработка, проверка и выпуск Rele

Разработка ведётся через GitHub issues и PR. [Схема CI](CI.md) использует два
параллельных GitHub-hosted runner-а: `ubuntu-24.04` и `windows-2025`, затем один
короткий Ubuntu `CI gate`. Draft PR получает быстрые проверки; ready PR и `main`
полный набор, включая сборку пакетов. В workflow есть public guard: jobs
выполняются только для публичного репозитория. Кэш отключён; обычные PR/main
runs не загружают artifacts. Только ручной release dispatch из `main` проходит
quota guard, временно передаёт пакеты publisher-у (retention transfer artifacts —
до одного дня) и создаёт draft RC.
GitHub Actions не заменяет приёмку готового пакета.

Текущая сборка и автоматические проверки выполняются на hosted runners. Приёмка
остаётся отдельным этапом: **Windows acceptance host — Windows**, **Linux
acceptance host — Linux**. Она проверяет только готовый установленный пакет,
без исходников и dev-suite. CI gate объединяет результаты обеих ОС, но текущий
ruleset репозитория (проверено 2026-11-12) пока не требует его как условие merge; настройки защиты main
ведутся отдельно в issue #8.

В этапе acceptance не запускаются `npm ci`, typecheck, Vitest, компиляция или
build/package scripts. На Windows и Linux acceptance hosts передаются только
готовые installers/portable и узкие операторские скрипты, без исходников
репозитория и dev-окружения.

## Рабочий цикл

1. Зарегистрировать проблему в issue: проверить дубли, выполнить triage и определить
   критерии приёмки. Включить выбранные issues в согласованный scope выпуска;
   milestone можно использовать для группировки, но он не обязателен.
2. Согласовать цель, границы изменения и критерии проверки. Работать в отдельной
   ветке/worktree; GitHub Actions проверяет точный commit PR и прикладывает checks
   к его SHA. CI использует отдельные фикстуры и тестовые профили без рабочей
   авторизации. Для acceptance передаются готовые installers/portable и узкие
   preflight/install/postflight-скрипты без исходников приложения и секретов.
   Новое разрешение на каждую обычную итерацию не требуется: commit/SHA и хеши
   файлов связывают evidence с конкретными байтами.
   Связать PR с issue через `Refs #…`.
   Не использовать автозакрывающие `Fixes`/`Closes`: merge ещё не означает приёмку.
   Сначала выполнять проверки изменённого
   участка и review готового diff. При сбое сначала проверять проблемный primitive
   или stage; не повторять полную сборку и матрицу ради каждой диагностической
   правки.
3. Заморозить RC и завершить обязательные unit/native/browser-проверки и сборку
   штатных пакетов на GitHub-hosted Windows и Ubuntu runners. Зафиксировать commit,
   версии инструментов и SHA256 пакетов. Новый diff, сбой или изменение среды
   требуют соответствующей перепроверки; узкий probe не заменяет итоговые gates.
4. Провести PR через review и `main`. Отдельный ручной release dispatch после
   quota guard передаёт проверенные байты publisher-у и создаёт draft RC без
   пересборки. Опубликованные assets/tag RC неизменяемы: последующие исправления
   выпускаются следующим RC, а не заменяют прежний пакет.
5. После публикации RC в этапе приёмки на Windows и Linux acceptance hosts
   проверить SHA256 полученных installers/portable, установить готовое приложение
   и выполнить приёмку его работы, обновления и восстановления. Windows
   owner/SID/ACL/DPAPI проверяются в интерактивном сеансе владельца; SSH session 0
   его не заменяет. Linux systemd проверяется на Linux acceptance host. Операторские
   скрипты работают с готовым приложением, не запускают source/dev-suite.
   Полный состав описан в [ACCEPTANCE.md](ACCEPTANCE.md).
6. Закрыть issue только после выполнения и принятия его критериев, со ссылкой
   на проверенный RC и evidence. Непроверенные критерии оставляют issue открытым.
   Переход к stable и согласованное обновление остальных машин выполняются
   только после приёмки RC и согласования этого этапа. Публикация, локальная установка, подключение runtime
   и реальная доставка в мессенджер фиксируются как разные результаты.

Согласованный scope определяет разрешённые действия; этот документ не расширяет
его на другие машины, рабочие профили или несогласованные операции. Отказ
автоматической проверки разрешений обязателен: его нельзя обходить или считать
снятым этим стандартом. Причину и оставшуюся границу нужно сообщить пользователю;
разрешённую независимую работу можно продолжать.

Секреты, auth и частная история не попадают в исходники, пакеты и публичные отчёты.
CI fixtures на hosted runners используют отдельные тестовые профили и локальный
provider. Там переиспользуются `scripts/protocol-probe.py`,
`scripts/managed-protocol-probe.py` и `scripts/shared-protocol-probe.py`;
их dev-окружение не используется для приёмки установленного приложения.
Рабочие auth и история Codex не копируются в build- или тестовые профили.

Standalone installer canary (`scripts/windows/ci-standard-user-canary.ps1`)
requires `-AcceptanceComputerName` with the explicitly selected disposable Windows
host name. Missing or nonmatching names stop the probe before changes. Other
standalone scratch-tree and owner checks remain required. This parameter does
not authorize using a production machine.
