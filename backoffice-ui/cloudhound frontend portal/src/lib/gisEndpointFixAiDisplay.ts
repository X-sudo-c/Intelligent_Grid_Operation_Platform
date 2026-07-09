import type { GiopEndpointFixAiReview, GiopEndpointFixAiTranscriptEntry } from '../api/giop-api';

const JSON_FENCE_RE = /```json\s*(\{[\s\S]*?\})\s*```/i;
const TRAILING_JSON_RE = /```json[\s\S]*$/i;

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Pull steward-facing summary text out of thoughts field (may be prose or raw JSON). */
export function formatEndpointFixAiThoughts(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) return '';

  if (text.startsWith('{')) {
    const payload = tryParseJson(text);
    if (payload) {
      const thoughts = payload.thoughts;
      if (typeof thoughts === 'string' && thoughts.trim()) return thoughts.trim();
      return summarizeReviewsFromPayload(payload);
    }
  }

  const fence = text.match(JSON_FENCE_RE);
  if (fence) {
    const payload = tryParseJson(fence[1]);
    const prose = text.replace(JSON_FENCE_RE, '').trim();
    if (typeof payload?.thoughts === 'string' && payload.thoughts.trim()) {
      return prose ? `${prose}\n\n${payload.thoughts.trim()}` : payload.thoughts.trim();
    }
    if (prose) return prose;
    if (payload) return summarizeReviewsFromPayload(payload);
  }

  return text.replace(TRAILING_JSON_RE, '').trim();
}

function summarizeReviewsFromPayload(payload: Record<string, unknown>): string {
  const reviews = payload.reviews;
  if (!Array.isArray(reviews) || reviews.length === 0) return '';
  const agrees = reviews.filter((r) => r && typeof r === 'object' && (r as GiopEndpointFixAiReview).agree).length;
  return `Reviewed ${reviews.length} proposals — ${agrees} agree, ${reviews.length - agrees} need review.`;
}

export function summarizeEndpointFixAiReviews(reviews: GiopEndpointFixAiReview[]): string {
  if (!reviews.length) return '';
  const agrees = reviews.filter((r) => r.agree !== false).length;
  const disagrees = reviews.filter((r) => r.agree === false).length;
  const high = reviews.filter((r) => r.confidence === 'high' && r.agree !== false).length;
  return `${reviews.length} reviewed · ${high} high confidence · ${agrees} agree · ${disagrees} disagree`;
}

/** Hide raw JSON blobs and internal LLM prompts from steward transcript. */
export function sanitizeEndpointFixTranscript(
  transcript: GiopEndpointFixAiTranscriptEntry[],
): GiopEndpointFixAiTranscriptEntry[] {
  return transcript
    .map((entry) => {
      if (entry.role === 'user') {
        return null;
      }
      if (entry.role !== 'assistant' || !entry.content) return entry;
      const cleaned = entry.content.replace(JSON_FENCE_RE, '').replace(TRAILING_JSON_RE, '').trim();
      if (!cleaned) return null;
      return { ...entry, content: cleaned };
    })
    .filter((entry): entry is GiopEndpointFixAiTranscriptEntry => entry !== null);
}
