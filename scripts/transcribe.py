"""Local-only transcription. A pre-downloaded faster-whisper model is required."""
import argparse
import json
import os
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", default="ru")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    model_path = Path(args.model)
    input_path = Path(args.input)
    if not model_path.is_absolute() or not model_path.is_dir():
        raise ValueError("An existing absolute local model directory is required")
    if not input_path.is_file():
        raise ValueError("An existing local audio file is required")
    from faster_whisper import WhisperModel
    model = WhisperModel(str(model_path), device=args.device,
                         compute_type="int8" if args.device == "cpu" else "float16",
                         local_files_only=True)
    segments, _ = model.transcribe(str(input_path.resolve()), language=args.language or None,
                                  vad_filter=True, beam_size=5)
    print(json.dumps({"text": " ".join(segment.text.strip() for segment in segments)}, ensure_ascii=True))

if __name__ == "__main__":
    main()
