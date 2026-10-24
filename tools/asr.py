#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""极简离线中文语音识别：wav(任意采样率/声道) -> 文本 JSON。

用法: python asr.py <wav路径> [模型目录]
输出: {"ok": true, "text": "..."}  /  {"ok": false, "error": "..."}

模型目录优先级：命令行第二个参数 > 环境变量 VOSK_MODEL > <本文件>/../models/vosk-model-small-cn-0.22
（vosk 的 C++ 层不认 UTF-8 中文路径，模型目录必须放在纯 ASCII 路径下）
"""
import json
import os
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.abspath(os.path.join(HERE, "..", "models", "vosk-model-small-cn-0.22"))
TARGET_RATE = 16000


def resolve_model():
    arg = sys.argv[2].strip() if len(sys.argv) > 2 else ""
    return arg or os.environ.get("VOSK_MODEL", "").strip() or DEFAULT_MODEL


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(0)


def read_wav_pcm16(path):
    """返回 (pcm_bytes, rate, channels)。"""
    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if width != 2:
        fail("只支持 16bit PCM，收到 sampwidth=%d" % width)
    if channels == 1:
        return frames, rate, 1
    # 多声道降成单声道
    import numpy as np

    arr = np.frombuffer(frames, dtype="<i2").reshape(-1, channels)
    mono = arr.mean(axis=1).astype("<i2")
    return mono.tobytes(), rate, 1


def resample(pcm, src_rate, dst_rate):
    if src_rate == dst_rate:
        return pcm
    import numpy as np

    src = np.frombuffer(pcm, dtype="<i2")
    n_out = int(round(len(src) * dst_rate / float(src_rate)))
    if n_out <= 0:
        return b""
    x_old = np.linspace(0.0, 1.0, num=len(src), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
    out = np.interp(x_new, x_old, src.astype(np.float32))
    return np.clip(out, -32768, 32767).astype("<i2").tobytes()


def main():
    if len(sys.argv) < 2:
        fail("缺少 wav 路径参数")
    path = sys.argv[1]
    try:
        pcm, rate, _ = read_wav_pcm16(path)
    except Exception as exc:  # noqa: BLE001
        fail("读取 wav 失败: %s" % exc)

    if not pcm:
        fail("音频为空")

    pcm = resample(pcm, rate, TARGET_RATE)

    from vosk import KaldiRecognizer, Model, SetLogLevel

    SetLogLevel(-1)
    model_path = resolve_model()
    try:
        model = Model(model_path)
    except Exception as exc:  # noqa: BLE001
        fail("加载模型失败(%s): %s" % (model_path, exc))

    rec = KaldiRecognizer(model, TARGET_RATE)
    rec.SetWords(False)

    chunks = []
    step = TARGET_RATE * 2 * 2  # 约 500ms
    for i in range(0, len(pcm), step):
        if rec.AcceptWaveform(pcm[i : i + step]):
            chunks.append(json.loads(rec.Result()).get("text", ""))
    chunks.append(json.loads(rec.FinalResult()).get("text", ""))

    text = "".join(chunks).replace(" ", "").strip()
    print(json.dumps({"ok": True, "text": text}, ensure_ascii=False))


if __name__ == "__main__":
    main()
