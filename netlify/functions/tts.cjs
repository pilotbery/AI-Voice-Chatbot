const GROQ_API_KEY = process.env.GROQ_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    if (!GROQ_API_KEY) return json(500, { error: "Missing GROQ_API_KEY env var" });

    const { text, voice = "hannah" } = JSON.parse(event.body || "{}");
    if (!text) return json(400, { error: "Missing text" });

    // Orpheus max ~200 chars
    const safeText = String(text).slice(0, 200);

    const resp = await fetch("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "canopylabs/orpheus-v1-english",
        input: safeText,
        voice,
        response_format: "wav"
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return json(resp.status, { error: err?.error?.message || "TTS error", raw: err });
    }

    const buf = Buffer.from(await resp.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store"
      },
      body: buf.toString("base64"),
      isBase64Encoded: true
    };
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
