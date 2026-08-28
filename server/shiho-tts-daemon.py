#!/usr/bin/env python3
"""
Shiho TTS Daemon — persistent Qwen3-TTS voice-clone server for Clawatar.

Keeps the Qwen3-TTS model loaded in VRAM (AMD ROCm / R9700) and exposes a
simple HTTP API so the Clawatar ws-server can request audio without paying
the ~30-60s model-load penalty on every single utterance.

Endpoints:
  GET  /health           -> {"ok":true,"ready":true|false}
  POST /synthesize       -> {"text": "...", "language": "German"} (JSON body)
                          -> {"ok":true,"path":"/abs/path.wav","duration":1.23}

Runs on 127.0.0.1:8766 (loopback only — never expose).
"""

import json
import os
import sys
import threading
import tempfile
import time
import gc
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

os.environ.setdefault("FLASH_ATTENTION_TRITON_AMD_ENABLE", "TRUE")
os.environ.setdefault("MIOPEN_FIND_MODE", "FAST")

HOST = "127.0.0.1"
PORT = int(os.environ.get("SHIHO_TTS_PORT", "8766"))
DEFAULT_LANGUAGE = "German"

# Same voice reference as qwen_tts_send.sh uses
DEFAULT_REFERENCE = os.path.expanduser("~/qwen_tts_voice_reference.wav")
DEFAULT_REF_TEXT = (
    "Solche Termine sind heikel. Leute in ihrer Situation stehen bereits unter "
    "Stress und fassen die Anwesenheit eines Ermittlers oft als Beschuldigung auf, "
    "ihren Besitz selbst zerstört zu haben. Nur in diesem Fall haben sie uns ja "
    "einen Verdächtigen genannt, gegen den wir natürlich zusammen mit der Polizei "
    "ermitteln werden. Aber in der Zwischenzeit ist hier die Liste ihres "
    "versicherten Eigentums. Unterschreiben Sie, dass die aufgelisteten "
    "Gegenstände Ihnen gehören und sich im Haus befanden, als das Feuer ausbrach, "
    "was nicht im Haus war, streichen Sie durch. Es gab, wie ich höre, eine "
    "Veränderung der Wohnsituation. Der letzte Punkt ist demnach besonders wichtig."
)
MODEL_NAME = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"

OUT_DIR = os.environ.get("SHIHO_TTS_OUTDIR", "/tmp/shiho-tts")
MAX_TEXT_CHARS = 800

_model = None
_model_lock = threading.Lock()
_gen_lock = threading.Lock()  # serialize GPU generation
_ready = False
_load_error = None


def load_model():
    """Load the TTS model once; runs in a background thread so /health answers immediately."""
    global _model, _ready, _load_error
    try:
        import torch
        from qwen_tts import Qwen3TTSModel

        if torch.cuda.is_available():
            device = "cuda:0"
        elif torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"

        print(f"[tts-daemon] Using device: {device}", file=sys.stderr, flush=True)
        torch.cuda.empty_cache()
        gc.collect()
        model = Qwen3TTSModel.from_pretrained(
            MODEL_NAME,
            device_map=device,
            dtype=torch.float32,
        )
        with _model_lock:
            _model = model
            _ready = True
        print("[tts-daemon] Model loaded and ready.", file=sys.stderr, flush=True)
    except Exception as e:  # noqa: BLE001
        _load_error = str(e)
        print(f"[tts-daemon] FAILED to load model: {e}", file=sys.stderr, flush=True)


def synthesize(text: str, language: str) -> dict:
    """Generate speech, write a wav, return metadata dict."""
    import torch
    import soundfile as sf

    with _model_lock:
        model = _model
    if model is None:
        raise RuntimeError("Model not loaded (yet)")

    os.makedirs(OUT_DIR, exist_ok=True)
    fd, out_path = tempfile.mkstemp(prefix="utt_", suffix=".wav", dir=OUT_DIR)
    os.close(fd)

    t0 = time.time()
    with _gen_lock:  # one GPU generation at a time
        torch.cuda.empty_cache()
        wavs, sr = model.generate_voice_clone(
            text=text,
            language=language,
            ref_audio=DEFAULT_REFERENCE,
            ref_text=DEFAULT_REF_TEXT,
            x_vector_only_mode=True,
            max_new_tokens=2048,
        )
    sf.write(out_path, wavs[0], sr)
    duration = len(wavs[0]) / sr
    elapsed = time.time() - t0
    print(f"[tts-daemon] {len(text)} chars -> {duration:.1f}s audio in {elapsed:.1f}s", file=sys.stderr, flush=True)
    return {"ok": True, "path": out_path, "duration": round(duration, 2), "elapsed": round(elapsed, 2)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter logs
        pass

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._json(200, {"ok": True, "ready": _ready, "error": _load_error})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/synthesize":
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            text = (payload.get("text") or "").strip()
            language = payload.get("language") or DEFAULT_LANGUAGE
            if not text:
                self._json(400, {"ok": False, "error": "empty text"})
                return
            if len(text) > MAX_TEXT_CHARS:
                self._json(400, {"ok": False, "error": f"text too long ({len(text)} > {MAX_TEXT_CHARS})"})
                return
            if not _ready:
                self._json(503, {"ok": False, "error": "model still loading"})
                return
            result = synthesize(text, language)
            self._json(200, result)
        except Exception as e:  # noqa: BLE001
            self._json(500, {"ok": False, "error": str(e)})


def prune_old_wavs(keep: int = 128):
    try:
        files = sorted(
            (os.path.join(OUT_DIR, f) for f in os.listdir(OUT_DIR) if f.endswith(".wav")),
            key=os.path.getmtime,
        )
        for f in files[:-keep]:
            os.unlink(f)
    except OSError:
        pass


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    prune_old_wavs()

    threading.Thread(target=load_model, daemon=True).start()

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[tts-daemon] Listening on http://{HOST}:{PORT} (model loading in background...)", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass