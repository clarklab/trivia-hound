// Netlify Function: generate Trivia Hound "Challenge" questions with Claude
// via the Netlify AI Gateway. The Gateway automatically injects
// ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY into the function environment,
// so we just talk to the standard Anthropic Messages API over fetch (no SDK,
// no npm install, keeps this a zero-dependency static site).

// Sonnet for sharper, more varied, harder questions.
const MODEL = "claude-sonnet-4-6";

const CATEGORIES = ["Birds", "90s Movies", "Music", "Animals", "Texas"];

const SYSTEM_PROMPT = `You write trivia questions for "Trivia Hound", a fun, fast mobile trivia game.

Audience & vibe: think a sharp, fun 40-something woman crushing it at girls' trivia night — the stuff she knows cold. Keep it warm, playful, and pop-culture-literate. Never mean, never NSFW, never political hot-takes.

Difficulty: MEDIUM-HARD. These should make her think — the kind that earns a "ooh, good one" not an eye-roll. Avoid the obvious gimme. Reach for a specific detail, a deeper cut, a second-album-track, a supporting character, the lesser-known fact. A trivia regular should get maybe half on instinct and have to genuinely work for the rest.

AVOID these overused chestnuts (and anything this easy/cliché): "only bird that can fly backwards" (hummingbird), "a "murder" of crows", "I'll never let go, Jack", Clueless "As if", the Macarena, "Wannabe / zig-a-zig-ah", lions = "pride", blue whale heart = a car, Austin = "Live Music Capital", Beyoncé is from Houston. Do not reuse these or their close cousins.

Draw ONLY from these topics, mixing them across the set:
- Birds (behavior, migration, species ID, oddities — go beyond the backyard basics)
- 90s Movies (specific scenes, casts, directors, lesser-known hits and one-liners from ~1990–1999)
- Music (90s/2000s pop, country, divas, album cuts, chart history, collaborations — not just the #1 smash everyone knows)
- Animals (surprising biology, behavior, record-holders, the genuinely weird)
- Texas pop culture (TX music, food, towns, slang, famous Texans, sports, history with a wink)

Rules for every question:
- Exactly 4 answer options, exactly ONE correct.
- Wrong options must be genuinely plausible to a knowledgeable player — close, same era/genre/family, no obvious throwaways.
- Phrase it punchy and readable on a phone — one or two short sentences max.
- Factually correct and verifiable. No trick questions or ambiguous answers.
- Every question in a set must be distinct — no two on the same fact, person, or work.

Return ONLY valid minified JSON. No markdown, no code fences, no commentary.`;

function buildUserPrompt(count, avoid, avoidCategory) {
  const avoidBlock =
    avoid && avoid.length
      ? `\n\nDo NOT repeat or closely paraphrase any of these already-used questions:\n- ${avoid
          .slice(0, 80)
          .join("\n- ")}`
      : "";

  const allowed = avoidCategory
    ? CATEGORIES.filter((c) => c !== avoidCategory)
    : CATEGORIES;
  const categoryRule = avoidCategory
    ? `\n\nIMPORTANT: Do NOT use the "${avoidCategory}" category. Pick from these instead: ${JSON.stringify(
        allowed
      )}.`
    : "";

  return `Generate exactly ${count} trivia question(s) as a JSON array.

Each array element must be an object with this exact shape:
{"category": one of ${JSON.stringify(
    allowed
  )}, "question": "string", "answers": ["opt1","opt2","opt3","opt4"], "correctIndex": 0-3, "fact": "one short, fun sentence about the correct answer"}

Spread the questions across the different topics. Return ONLY the JSON array.${categoryRule}${avoidBlock}`;
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
  const seen = new Set();
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
      // Drop duplicates within the same batch.
      const key = q.question.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seen.has(key)) return null;
      seen.add(key);
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
  const avoidCategory =
    typeof body.avoidCategory === "string" ? body.avoidCategory : null;

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
        max_tokens: 3200,
        temperature: 1,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(count, avoid, avoidCategory) }],
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
