# Локальное распознавание голосовых

Rele скачивает аудио из исходного мессенджера, запускает Python и передаёт в Codex текст. Временный файл удаляется после успеха, ошибки или отмены. Токены мессенджеров не передаются в аргументах Python.

## Установка

Установите Python 3.12 или 3.13 и создайте отдельное окружение. Ubuntu Server:

```bash
python3 -m venv ~/.local/share/rele-voice
~/.local/share/rele-voice/bin/python -m pip install -r scripts/voice-requirements.txt
```

Windows PowerShell:

```powershell
py -3.13 -m venv "$env:LOCALAPPDATA\ReleVoice"
& "$env:LOCALAPPDATA\ReleVoice\Scripts\python.exe" -m pip install -r scripts/voice-requirements.txt
```

Зафиксирован совместимый набор зависимостей, включая faster-whisper 1.2.1 и PyAV 18.1.0. PyAV 19 изменил используемый интерфейс декодирования и с этой версией faster-whisper несовместим. CPU использует int8. Для CUDA нужны совместимые системные библиотеки из документации faster-whisper; CPU достаточно для первого запуска.

## Модель

Отдельным установочным шагом скачайте модель CTranslate2 на ту же машину. Пример с `huggingface_hub` из установленного окружения:

```python
from huggingface_hub import snapshot_download
snapshot_download("Systran/faster-whisper-small", local_dir="/absolute/path/to/rele-model", token=False)
```

Подставьте реальный абсолютный путь вашей ОС. Загрузка требует интернета и не выполняется при получении голосового сообщения. Для русского языка нужна многоязычная модель; варианты `.en` предназначены для английского.

В панели задайте пути к Python и каталогу модели, язык `ru` либо пустое значение для автоопределения, устройство `cpu`, затем включите распознавание.

## Проверка

```bash
python scripts/transcribe.py --input /path/to/sample.ogg --model /absolute/path/to/rele-model --language ru --device cpu
```

Вывод — JSON с полем `text`. Рабочий процесс получает ограниченное окружение без API credentials, с `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `local_files_only=True`. Неполная модель приводит к ошибке, а не к скрытой загрузке. Перед удалением аудио Rele дожидается закрытия Python-процесса; оставшиеся после аварийного завершения каталоги очищаются при следующем запуске, если их уже не удерживает процесс.

Первый выпуск: один аудиофайл сообщения, максимум 20 МиБ, до 10 минут обработки. Неразборчивая речь или ошибка модели не запускают Codex. Аудио удаляется; текст остаётся в истории запроса и в Codex.

Источники: [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [модели Systran](https://huggingface.co/Systran), [CTranslate2](https://opennmt.net/CTranslate2/).
