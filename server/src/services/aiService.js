/**
 * AI Meeting Intelligence service.
 *
 * MVP scope: takes a transcript (either pasted manually, or accumulated from
 * the in-meeting chat/notes) and returns a summary + action items.
 *
 * - If OPENAI_API_KEY is set, calls the OpenAI Chat Completions API.
 * - Otherwise falls back to a small, dependency-free extractive summarizer
 *   so the whole app runs end-to-end for free, with no external API key.
 *
 * This keeps the "AI Meeting Intelligence" feature from the spec real and
 * demoable without requiring paid infrastructure to run the MVP.
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

async function summarizeWithOpenAI(transcript) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const systemPrompt = `You are IntellMeet's meeting-intelligence assistant. Given a raw meeting
transcript or chat log, respond ONLY with strict JSON of the shape:
{"summary": string, "actionItems": [{"text": string, "assignee": string}]}
Keep the summary to 3-6 sentences. Infer an assignee name from context when possible,
otherwise use "Unassigned". Do not include any text outside the JSON object.`;

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '{}';

  try {
    const parsed = JSON.parse(raw);
    return {
      summary: parsed.summary || '',
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
      engine: 'openai',
    };
  } catch {
    // Model didn't return clean JSON; fall back to treating it as plain summary text.
    return { summary: raw, actionItems: [], engine: 'openai-unstructured' };
  }
}

// --- Free, offline fallback -------------------------------------------------

const ACTION_CUES = [
  /\bwill\b/i,
  /\bneed(s)? to\b/i,
  /\btodo\b/i,
  /\baction item[s]?\b/i,
  /\bshould\b/i,
  /\bplease\b/i,
  /\bby (monday|tuesday|wednesday|thursday|friday|tomorrow|eod|next week)\b/i,
];

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Naive TF-based extractive summary: scores sentences by frequent, non-trivial words. */
function extractiveSummary(sentences, maxSentences = 4) {
  const stopwords = new Set(
    'the a an and or but of to in on for with is are was were be been being this that it as at by from'.split(' ')
  );
  const freq = {};
  sentences.forEach((s) => {
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(' ')
      .filter((w) => w && !stopwords.has(w))
      .forEach((w) => {
        freq[w] = (freq[w] || 0) + 1;
      });
  });

  const scored = sentences.map((s, idx) => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter(Boolean);
    const score = words.reduce((sum, w) => sum + (freq[w] || 0), 0) / Math.max(words.length, 1);
    return { s, idx, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.s)
    .join(' ');
}

function extractActionItems(sentences) {
  return sentences
    .filter((s) => ACTION_CUES.some((re) => re.test(s)))
    .slice(0, 10)
    .map((text) => {
      const nameMatch = text.match(/\b([A-Z][a-z]+)\b(?=[,:]?\s+(will|to|should|needs))/);
      return { text, assignee: nameMatch ? nameMatch[1] : 'Unassigned' };
    });
}

function summarizeOffline(transcript) {
  const sentences = splitSentences(transcript);
  if (sentences.length === 0) {
    return { summary: '', actionItems: [], engine: 'offline-empty' };
  }
  return {
    summary: extractiveSummary(sentences),
    actionItems: extractActionItems(sentences),
    engine: 'offline-extractive',
  };
}

// --- Public entry point ------------------------------------------------------

async function summarizeMeeting(transcript) {
  const cleaned = (transcript || '').trim();
  if (!cleaned) {
    return { summary: '', actionItems: [], engine: 'none' };
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      return await summarizeWithOpenAI(cleaned);
    } catch (err) {
      console.error('[aiService] OpenAI call failed, falling back to offline summarizer:', err.message);
      return summarizeOffline(cleaned);
    }
  }

  return summarizeOffline(cleaned);
}

module.exports = { summarizeMeeting };
