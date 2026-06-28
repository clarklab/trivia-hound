// Netlify Function: generate Trivia Hound "Challenge" questions with Claude
// via the Netlify AI Gateway. The Gateway automatically injects
// ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY into the function environment,
// so we just talk to the standard Anthropic Messages API over fetch (no SDK,
// no npm install, keeps this a zero-dependency static site).

// Haiku for the fastest generation; the JSON shape is simple and well-specified.
const MODEL = "claude-haiku-4-5";

const CATEGORIES = ["Birds", "90s Movies", "Music", "Animals", "Texas"];

const SYSTEM_PROMPT = `You write trivia questions for "Trivia Hound", a fun, fast mobile trivia game.

Audience & vibe: think a sharp, fun 40-something woman crushing it at girls' trivia night — the stuff she knows cold. Keep it warm, playful, and pop-culture-literate. Never mean, never NSFW, never political hot-takes.

Difficulty: MEDIUM. Not "name the capital" easy, not PhD obscure. A clever person should get most of them with a satisfying "ohhh yeah!"

Draw ONLY from these topics, mixing them across the set:
- Birds (backyard birds, famous birds, bird facts, bird behavior)
- 90s Movies (rom-coms, blockbusters, quotable classics from ~1990–1999)
- Music (90s/2000s pop, country, divas, one-hit wonders, iconic albums)
- Animals (cute, weird, and wild — mammals, pets, ocean critters)
- Texas pop culture (TX music, food, towns, slang, famous Texans, Friday Night Lights energy)

Rules for every question:
- Exactly 4 answer options, exactly ONE correct.
- Wrong options must be plausible and in the same spirit (no obvious throwaways).
- Phrase it punchy and readable on a phone — one or two short sentences max.
- Factually correct and verifiable.

Return ONLY valid minified JSON. No markdown, no code fences, no commentary.`;

function buildUserPrompt(count, avoid) {
  const avoidBlock =
    avoid && avoid.length
      ? `\n\nDo NOT repeat or closely paraphrase any of these already-used questions:\n- ${avoid
          .slice(0, 60)
          .join("\n- ")}`
      : "";
  return `Generate exactly ${count} trivia question(s) as a JSON array.

Each array element must be an object with this exact shape:
{"category": one of ${JSON.stringify(
    CATEGORIES
  )}, "question": "string", "answers": ["opt1","opt2","opt3","opt4"], "correctIndex": 0-3, "fact": "one short, fun sentence about the correct answer"}

Spread the questions across the different topics. Return ONLY the JSON array.${avoidBlock}`;
}

function extractJson(text) {
  if (!text) return null;
  // Strip code fences if the model added them anyway.
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Grab the outermost array.
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    t = t.slice(start, end + 1);
  }
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function sanitize(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((q) => {
      if (!q || typeof q.question !== "string" || !Array.isArray(q.answers))
        return null;
      const answers = q.answers.map((a) => String(a)).slice(0, 4);
      if (answers.length !== 4) return null;
      let correctIndex = Number(q.correctIndex);
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3)
        correctIndex = 0;
      const category = CATEGORIES.includes(q.category) ? q.category : "Music";
      return {
        category,
        question: q.question.trim(),
        answers,
        correctIndex,
        fact: typeof q.fact === "string" ? q.fact.trim() : "",
      };
    })
    .filter(Boolean);
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const count = Math.min(Math.max(parseInt(body.count, 10) || 10, 1), 20);
  const avoid = Array.isArray(body.avoid) ? body.avoid : [];

  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(
    /\/+$/,
    ""
  );
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: "AI Gateway not configured (missing ANTHROPIC_API_KEY).",
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }

  try {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2200,
        temperature: 1,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(count, avoid) }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return new Response(
        JSON.stringify({ error: "AI Gateway request failed", status: resp.status, detail }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }

    const data = await resp.json();
    const text =
      Array.isArray(data.content) && data.content.length
        ? data.content.map((c) => c.text || "").join("")
        : "";

    const questions = sanitize(extractJson(text)).slice(0, count);

    if (!questions.length) {
      return new Response(
        JSON.stringify({ error: "Could not parse questions from model output." }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ questions }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Unexpected error", detail: String(err) }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
};

export const config = {
  path: "/api/questions",
};
