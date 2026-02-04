const GROQ_API_KEY = process.env.GROQ_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    if (!GROQ_API_KEY) return json(500, { error: "Missing GROQ_API_KEY env var" });

    const {
      audioBase64,
      mimeType = "audio/webm",
      model = "whisper-large-v3-turbo",
      language
    } = JSON.parse(event.body || "{}");

    if (!audioBase64) return json(400, { error: "Missing audioBase64" });

    const buffer = Buffer.from(audioBase64, "base64");

    // Node 20 has fetch + FormData + Blob
    const form = new FormData();
    form.append("model", model);
    if (language) form.append("language", language);

    const blob = new Blob([buffer], { type: mimeType });
    const filename = mimeType.includes("wav") ? "audio.wav" : "audio.webm";
    form.append("file", blob, filename);

    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      body: form
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return json(resp.status, { error: data?.error?.message || "Transcription error", raw: data });
    }

    return json(200, { text: data.text || "" });
  } catch (err) {
    return json(500, { error: err?.message || "Server error" });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}
