const GROQ_API_KEY = process.env.GROQ_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    if (!GROQ_API_KEY) return json(500, { error: "Missing GROQ_API_KEY env var" });

    const { text, history = [] } = JSON.parse(event.body || "{}");
    if (!text) return json(400, { error: "Missing text" });

    const messages = [
      {
        role: "system",
        content:
          "You are ChatGPT. Respond naturally and helpfully like ChatGPT would. Be concise unless asked for depth."
      },
      ...history.slice(-12),
      { role: "user", content: text }
    ];

    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.4,
        max_tokens: 350
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return json(resp.status, { error: data?.error?.message || "Groq error", raw: data });
    }

    const reply = data?.choices?.[0]?.message?.content ?? "";
    return json(200, { reply });
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
