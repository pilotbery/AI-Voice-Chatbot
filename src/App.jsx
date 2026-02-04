import { useMemo, useRef, useState } from "react";
import "./App.css";

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Failed to read audio blob"));
    r.onload = () => {
      const s = String(r.result || "");
      const idx = s.indexOf("base64,");
      resolve(idx >= 0 ? s.slice(idx + 7) : "");
    };
    r.readAsDataURL(blob);
  });
}

// No regex lookbehind (safe everywhere)
function splitIntoSentences(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  const matches = s.match(/[^.!?]+[.!?]*/g);
  return matches ? matches.map((x) => x.trim()).filter(Boolean) : [s];
}

// Orpheus max input 200 chars → keep chunks <= 180
function chunkForOrpheus(text, max = 180) {
  const parts = splitIntoSentences(text);
  const out = [];
  let cur = "";

  for (const p of parts) {
    const next = (cur ? cur + " " : "") + p;
    if (next.length > max) {
      if (cur) out.push(cur);
      cur = p.length > max ? p.slice(0, max) : p;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export default function App() {
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);

  const [history, setHistory] = useState([]); // [{role, content}]
  const [lastUserText, setLastUserText] = useState("");
  const [typed, setTyped] = useState("");

  const [useGroqTTS, setUseGroqTTS] = useState(true);
  const [voice, setVoice] = useState("hannah");

  // ---- Recorder refs ----
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  // ---- Silence detection + meter refs ----
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(0);

  // Meter (wave bars)
  const N_BARS = 12;
  const [meterBars, setMeterBars] = useState(Array(N_BARS).fill(0));
  const lastMeterUpdateRef = useRef(0);
  const phaseRef = useRef(0);

  const startedAtRef = useRef(0);
  const lastLoudAtRef = useRef(0);
  const hardStopTimeoutRef = useRef(null);

  // Tune these:
  const SILENCE_MS = 1200; // auto-stop after this much silence
  const MIN_RECORD_MS = 600;
  const MAX_RECORD_MS = 15000; // safety hard-stop
  const THRESHOLD = 0.02; // lower = more sensitive

  const canRecord = useMemo(
    () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined",
    []
  );

  function cleanupAudio() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;

    if (hardStopTimeoutRef.current) clearTimeout(hardStopTimeoutRef.current);
    hardStopTimeoutRef.current = null;

    try {
      analyserRef.current?.disconnect?.();
    } catch {}
    analyserRef.current = null;

    try {
      audioCtxRef.current?.close?.();
    } catch {}
    audioCtxRef.current = null;

    setMeterBars(Array(N_BARS).fill(0));
    phaseRef.current = 0;
  }

  function startSilenceAndMeter(stream) {
    cleanupAudio();

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyserRef.current = analyser;

    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);

    const now0 = performance.now();
    startedAtRef.current = now0;
    lastLoudAtRef.current = now0;

    // Hard stop safety
    hardStopTimeoutRef.current = setTimeout(() => {
      if (recording) stopRecording();
    }, MAX_RECORD_MS);

    const tick = () => {
      if (!analyserRef.current) return;

      analyserRef.current.getByteTimeDomainData(data);

      // Avg deviation from center (128)
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
      const avg = sum / data.length;
      const norm = (avg / 128) || 0; // ~0..1

      const now = performance.now();
      const isLoud = norm > THRESHOLD;
      if (isLoud) lastLoudAtRef.current = now;

      // ---- Meter update (throttled ~15fps) ----
      if (now - lastMeterUpdateRef.current > 66) {
        lastMeterUpdateRef.current = now;
        phaseRef.current += 0.35;

        // amplify a bit so it looks alive
        const v = Math.min(1, norm * 4);

        const bars = Array.from({ length: N_BARS }, (_, i) => {
          const wave = Math.abs(Math.sin(phaseRef.current + i * 0.55));
          const base = 0.2 + 0.8 * wave;
          // make center bars a bit taller
          const centerBoost = 1 - Math.abs(i - (N_BARS - 1) / 2) / ((N_BARS - 1) / 2);
          const h = Math.min(1, v * (0.55 * base + 0.45 * centerBoost));
          return h;
        });

        setMeterBars(bars);
      }

      const sinceStart = now - startedAtRef.current;
      const sinceLoud = now - lastLoudAtRef.current;

      // Auto-stop on silence (after minimum time)
      if (sinceStart > MIN_RECORD_MS && sinceLoud > SILENCE_MS) {
        stopRecording();
        return;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }

  async function startRecording() {
    setStatus("");
    setLastUserText("");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    startSilenceAndMeter(stream);

    const rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorderRef.current = rec;
    chunksRef.current = [];

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    rec.onstop = async () => {
      try {
        cleanupAudio();
        setStatus("Transcribing…");

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });

        // Stop mic
        streamRef.current?.getTracks?.().forEach((t) => t.stop());
        streamRef.current = null;

        const audioBase64 = await blobToBase64(blob);

        const tr = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioBase64,
            mimeType: "audio/webm",
            model: "whisper-large-v3-turbo",
          }),
        });

        const trData = await tr.json();
        if (!tr.ok) {
          setStatus(`Transcribe error: ${trData.error || "Request failed"}`);
          return;
        }

        const text = (trData.text || "").trim();
        setLastUserText(text);

        if (!text) {
          setStatus("Didn’t catch that — try again.");
          return;
        }

        await askBot(text);
      } catch (e) {
        setStatus(`Recording/transcribe failed: ${e?.message || "error"}`);
      } finally {
        setRecording(false);
      }
    };

    rec.start();
    setRecording(true);
    setStatus("Listening… (auto-stops on silence)");
  }

  function stopRecording() {
    try {
      cleanupAudio();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    } catch {
      // ignore
    }
  }

  async function askBot(text) {
    setStatus("Thinking…");

    const nextHistory = [...history, { role: "user", content: text }].slice(-12);
    setHistory(nextHistory);

    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, history: nextHistory }),
    });

    const data = await res.json();
    if (!res.ok) {
      setStatus(`Ask error: ${data.error || "Request failed"}`);
      return;
    }

    const reply = (data.reply || "").trim();
    setHistory((h) => [...h, { role: "assistant", content: reply }]);
    setStatus("");

    if (useGroqTTS) {
      await speakWithGroq(reply);
    } else {
      speakWithBrowser(reply);
    }
  }

  function speakWithBrowser(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(u);
  }

  async function speakWithGroq(text) {
    const chunks = chunkForOrpheus(text, 180);
    if (chunks.length === 0) return;

    setStatus("Speaking…");

    for (const c of chunks) {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: c, voice }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setStatus(`TTS error: ${err.error || "Request failed"}`);
        return;
      }

      const buf = await res.arrayBuffer();
      const blob = new Blob([buf], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);

      await new Promise((resolve, reject) => {
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onerror = (e) => {
          URL.revokeObjectURL(url);
          reject(e);
        };
        audio.play().catch(reject);
      });
    }

    setStatus("");
  }

  async function onSendTyped() {
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    setLastUserText(text);
    await askBot(text);
  }

  return (
    <div className="wrap">
      <h1 className="title">Groq Voice Bot</h1>

      <div className="row">
        <button
          className="btn"
          disabled={!canRecord}
          onClick={() => (recording ? stopRecording() : startRecording())}
        >
          {recording ? "⏹ Stop" : "🎙️ Talk"}
        </button>

        {/* Meter */}
        <div className={`meter ${recording ? "" : "meterOff"}`} aria-label="Mic level">
          {meterBars.map((h, i) => (
            <div
              key={i}
              className="meterBar"
              style={{ transform: `scaleY(${Math.max(0.06, h)})` }}
            />
          ))}
        </div>

        <label className="toggle">
          <input
            type="checkbox"
            checked={useGroqTTS}
            onChange={(e) => setUseGroqTTS(e.target.checked)}
          />
          Use Groq TTS (Orpheus)
        </label>

        <select
          className="select"
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          disabled={!useGroqTTS}
        >
          <option value="autumn">autumn</option>
          <option value="diana">diana</option>
          <option value="hannah">hannah</option>
          <option value="austin">austin</option>
          <option value="daniel">daniel</option>
          <option value="troy">troy</option>
        </select>

        <span className="status">{status}</span>
      </div>

      <div className="card">
        <div className="typedRow">
          <input
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type a message…"
            onKeyDown={(e) => e.key === "Enter" && onSendTyped()}
          />
          <button className="btn" onClick={onSendTyped}>
            Send
          </button>
        </div>

        {lastUserText ? (
          <div className="heard">
            <strong>You:</strong> {lastUserText}
          </div>
        ) : null}

        <div className="chat">
          {history.length === 0 ? (
            <div className="muted">Click Talk → speak → it auto-stops on silence.</div>
          ) : (
            history.map((m, i) => (
              <div key={i} className="msg">
                <span className="role">{m.role === "user" ? "You" : "Bot"}:</span>
                <span>{m.content}</span>
              </div>
            ))
          )}
        </div>

        <div className="note">
          Adjust <code>THRESHOLD</code> and <code>SILENCE_MS</code> in <code>App.jsx</code> if auto-stop
          is too sensitive.
        </div>
      </div>
    </div>
  );
}
