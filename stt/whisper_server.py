"""Hindi / Hinglish speech-to-text for Udhaar Agent voice notes, on a GPU (built for Nodus compute at the finale).

Speaks the OpenAI audio API, so the shop server only needs STT_URL pointed here:
    POST /v1/audio/transcriptions   multipart: file, model (ignored), language (default hi), prompt (optional)
    ->  {"text": "..."}

Run:  pip install -r requirements.txt && uvicorn whisper_server:app --host 0.0.0.0 --port 9000
Env:  WHISPER_MODEL (default large-v3), WHISPER_DEVICE (default cuda; "cpu" to try it on a laptop with a small model),
      STT_KEY (optional bearer token the shop server must send)
Voice notes are transcribed in memory and never saved.
"""
import os
import tempfile
import time

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
KEY = os.environ.get("STT_KEY", "")
MAX_BYTES = 16 * 1024 * 1024

model = WhisperModel(MODEL, device=DEVICE, compute_type="float16" if DEVICE == "cuda" else "int8")
app = FastAPI()


@app.get("/healthz")
def healthz():
    return {"ok": True, "model": MODEL, "device": DEVICE}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str = Form("whisper-1", alias="model"),
    language: str = Form("hi"),
    prompt: str = Form(""),
    authorization: str = Header(""),
):
    if KEY and authorization != "Bearer " + KEY:
        raise HTTPException(401, "bad key")
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "voice note too long")
    t0 = time.time()
    # faster-whisper decodes through ffmpeg (PyAV), so WhatsApp's ogg/opus works as is
    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(file.filename or "")[1] or ".ogg") as f:
        f.write(data)
        f.flush()
        segments, info = model.transcribe(
            f.name,
            language=None if language == "auto" else language,
            initial_prompt=prompt or None,
            beam_size=5,
            vad_filter=True,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language, "seconds": round(time.time() - t0, 2)}
