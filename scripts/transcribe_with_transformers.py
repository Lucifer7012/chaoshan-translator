import argparse
import sys


def normalize_language(value: str) -> str:
    language = (value or "").strip().lower()
    aliases = {
        "zh": "chinese",
        "zh-cn": "chinese",
        "zh-tw": "chinese",
        "cmn": "chinese",
    }
    return aliases.get(language, language or "chinese")


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio with a Hugging Face Whisper model.")
    parser.add_argument("audio_path")
    parser.add_argument("--model", required=True)
    parser.add_argument("--processor", default="")
    parser.add_argument("--language", default="zh")
    args = parser.parse_args()

    try:
        import librosa
        import torch
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
    except ImportError as error:
        raise SystemExit(
            "缺少 Python 依赖，请先运行：pip install -U torch transformers accelerate ffmpeg-python soundfile librosa"
        ) from error

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    processor_name = args.processor or args.model

    processor = AutoProcessor.from_pretrained(processor_name)
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        args.model,
        torch_dtype=dtype,
        low_cpu_mem_usage=True
    )
    model.to(device)
    model.eval()

    audio, sampling_rate = librosa.load(args.audio_path, sr=16000, mono=True)
    inputs = processor(
        audio,
        sampling_rate=sampling_rate,
        return_tensors="pt",
        return_attention_mask=True
    )
    input_features = inputs.input_features.to(device=device, dtype=dtype)
    attention_mask = getattr(inputs, "attention_mask", None)
    if attention_mask is not None:
        attention_mask = attention_mask.to(device=device)

    forced_decoder_ids = None
    if hasattr(processor, "get_decoder_prompt_ids"):
        language = normalize_language(args.language)
        try:
            forced_decoder_ids = processor.get_decoder_prompt_ids(
                language=language,
                task="transcribe"
            )
        except Exception:
            forced_decoder_ids = None

    if forced_decoder_ids:
        model.generation_config.forced_decoder_ids = forced_decoder_ids

    generate_kwargs = {}
    if attention_mask is not None:
        generate_kwargs["attention_mask"] = attention_mask

    predicted_ids = model.generate(input_features, **generate_kwargs)
    text = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
    sys.stdout.write(text.strip())


if __name__ == "__main__":
    main()
