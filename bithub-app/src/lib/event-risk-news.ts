// Event-risk headlines. Server-side only, no API key.

const GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc";
const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";

type EventTopic = "geopolitical" | "macro" | "crypto_policy" | "market_plumbing";
type EventSeverity = "critical" | "high" | "medium" | "low";

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
  sourceCountry?: string;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

export interface EventRiskHeadline {
  id: string;
  topic: EventTopic;
  severity: EventSeverity;
  risk_score: number;
  rank_score: number;
  age_hours: number;
  is_breaking: boolean;
  is_stale: boolean;
  title: string;
  source: string;
  url: string;
  published_at: string;
  source_country: string | null;
  matched_terms: string[];
}

export interface EventRiskSnapshot {
  ok: true;
  source: "google_news_rss" | "gdelt";
  as_of: string;
  window: "24h";
  risk_level: "quiet" | "watch" | "elevated" | "critical";
  max_risk_score: number;
  headlines: EventRiskHeadline[];
}

const EVENT_QUERY = [
  "Iran",
  "Israel",
  '"Strait of Hormuz"',
  '"Red Sea"',
  "Houthis",
  '"missile strike"',
  "ceasefire",
  "sanctions",
  '"Federal Reserve"',
  '"Fed minutes"',
  "CPI",
  '"PCE inflation"',
  '"nonfarm payrolls"',
  '"Treasury yields"',
  '"dollar index"',
  '"Bitcoin ETF"',
  '"Ethereum ETF"',
  '"SEC crypto"',
  '"crypto regulation"',
  '"stablecoin bill"',
  '"crypto liquidations"',
  '"exchange outage"',
  '"bridge exploit"',
  "Tether",
].join(" OR ");

const TERMS = [
  "iran",
  "israel",
  "hormuz",
  "red sea",
  "houthi",
  "missile",
  "attack",
  "strike",
  "war",
  "ceasefire",
  "sanction",
  "nuclear",
  "fed",
  "cpi",
  "pce",
  "payroll",
  "treasury",
  "dollar",
  "etf",
  "sec",
  "regulation",
  "liquidation",
  "outage",
  "hack",
  "exploit",
  "tether",
];

export async function fetchEventRiskNews(): Promise<EventRiskSnapshot> {
  const freshCutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const headlines = (await fetchGoogleNewsRss(EVENT_QUERY)).filter(
    (h) => h.title && h.url && Date.parse(h.published_at) >= freshCutoffMs,
  );
  const deduped = dedupe(headlines)
    .sort((a, b) => b.rank_score - a.rank_score || Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, 16);
  const max_risk_score = deduped[0]?.risk_score ?? 0;

  return {
    ok: true,
    source: "google_news_rss",
    as_of: new Date().toISOString(),
    window: "24h",
    risk_level: riskLevel(max_risk_score),
    max_risk_score,
    headlines: deduped,
  };
}

async function fetchGoogleNewsRss(query: string): Promise<EventRiskHeadline[]> {
  const qs = new URLSearchParams({
    q: `(${query}) when:1d`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  const res = await fetch(`${GOOGLE_NEWS_RSS}?${qs}`, {
    headers: { "User-Agent": "Bithub-Research/0.1 (server-side event-risk)" },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Google News RSS returned ${res.status}`);
  const xml = await res.text();
  return parseGoogleNewsItems(xml);
}

async function fetchEventQuery(query: string): Promise<EventRiskHeadline[]> {
  const qs = new URLSearchParams({
    query: `(${query})`,
    mode: "ArtList",
    format: "json",
    maxrecords: "50",
    sort: "DateDesc",
    timespan: "24h",
  });
  const res = await fetch(`${GDELT_DOC}?${qs}`, {
    headers: { "User-Agent": "Bithub-Research/0.1 (server-side event-risk)" },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`GDELT returned ${res.status}`);
  const body = (await res.json()) as GdeltResponse;
  return (body.articles ?? []).map(toHeadline).filter((h): h is EventRiskHeadline => h !== null);
}

function parseGoogleNewsItems(xml: string): EventRiskHeadline[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items
    .map((item): EventRiskHeadline | null => {
      const rawTitle = readXmlTag(item, "title");
      const rawUrl = readXmlTag(item, "link");
      if (!rawTitle || !rawUrl) return null;
      const { title, source } = splitGoogleNewsTitle(decodeXml(rawTitle));
      const published_at = normalizeRssDate(decodeXml(readXmlTag(item, "pubDate") ?? ""));
      const topic = detectTopic(title);
      const matched_terms = matchedTerms(title);
      const risk_score = scoreHeadline(topic, title, matched_terms);
      const age_hours = ageHours(published_at);
      return {
        id: stableId(rawUrl),
        topic,
        severity: severityFor(risk_score),
        risk_score,
        rank_score: rankScore(risk_score, age_hours),
        age_hours,
        is_breaking: age_hours <= 3,
        is_stale: age_hours > 12,
        title,
        source,
        url: decodeXml(rawUrl),
        published_at,
        source_country: null,
        matched_terms,
      };
    })
    .filter((h): h is EventRiskHeadline => h !== null);
}

function readXmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
  return match?.[1]?.trim() ?? null;
}

function splitGoogleNewsTitle(value: string): { title: string; source: string } {
  const parts = value.split(" - ");
  if (parts.length < 2) return { title: value, source: "Google News" };
  return { title: parts.slice(0, -1).join(" - "), source: parts.at(-1) ?? "Google News" };
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function normalizeRssDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function toHeadline(article: GdeltArticle): EventRiskHeadline | null {
  if (!article.title || !article.url) return null;
  const topic = detectTopic(article.title);
  const matched_terms = matchedTerms(article.title);
  const risk_score = scoreHeadline(topic, article.title, matched_terms);
  const published_at = normalizeGdeltDate(article.seendate);
  const age_hours = ageHours(published_at);
  return {
    id: stableId(article.url),
    topic,
    severity: severityFor(risk_score),
    risk_score,
    rank_score: rankScore(risk_score, age_hours),
    age_hours,
    is_breaking: age_hours <= 3,
    is_stale: age_hours > 12,
    title: article.title,
    source: article.domain ?? "unknown",
    url: article.url,
    published_at,
    source_country: article.sourcecountry ?? article.sourceCountry ?? null,
    matched_terms,
  };
}

function detectTopic(title: string): EventTopic {
  const text = title.toLowerCase();
  if (/(fed|cpi|pce|payroll|treasury|dollar index|inflation)/i.test(text)) return "macro";
  if (/(sec|etf|regulation|stablecoin|coinbase|binance)/i.test(text)) return "crypto_policy";
  if (/(liquidation|outage|hack|exploit|bridge exploit|tether)/i.test(text)) return "market_plumbing";
  return "geopolitical";
}

function scoreHeadline(topic: EventTopic, title: string, matched: string[]): number {
  const text = title.toLowerCase();
  let score = topic === "geopolitical" ? 35 : topic === "market_plumbing" ? 28 : 22;
  score += Math.min(matched.length * 6, 36);
  if (/(missile|attack|strike|war|hormuz|nuclear|sanction)/i.test(text)) score += 22;
  if (/(fed|cpi|pce|payroll|treasury|dollar)/i.test(text)) score += 12;
  if (/(liquidation|outage|hack|exploit|tether)/i.test(text)) score += 16;
  if (/(crypto|bitcoin|ethereum|btc|eth|stablecoin|etf)/i.test(text)) score += 8;
  return Math.max(0, Math.min(100, score));
}

function matchedTerms(title: string): string[] {
  const text = title.toLowerCase();
  return TERMS.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = term.includes(" ") ? escaped : `\\b${escaped}\\b`;
    return new RegExp(pattern, "i").test(text);
  });
}

function severityFor(score: number): EventSeverity {
  if (score >= 80) return "critical";
  if (score >= 62) return "high";
  if (score >= 42) return "medium";
  return "low";
}

function riskLevel(score: number): EventRiskSnapshot["risk_level"] {
  if (score >= 80) return "critical";
  if (score >= 62) return "elevated";
  if (score >= 42) return "watch";
  return "quiet";
}

function ageHours(iso: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 999;
  return Math.max(0, Math.round(((Date.now() - parsed) / 3_600_000) * 10) / 10);
}

function rankScore(riskScore: number, age_hours: number): number {
  const breakingBoost = age_hours <= 3 ? 18 : age_hours <= 6 ? 8 : 0;
  const agePenalty = Math.min(age_hours, 24) * 1.2;
  return Math.round((riskScore + breakingBoost - agePenalty) * 10) / 10;
}

function dedupe(headlines: EventRiskHeadline[]): EventRiskHeadline[] {
  const seen = new Set<string>();
  const out: EventRiskHeadline[] = [];
  for (const h of headlines) {
    const key = `${h.url}|${h.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function normalizeGdeltDate(value?: string): string {
  if (!value) return new Date().toISOString();
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (compact) {
    const [, y, m, d, hh, mm, ss] = compact;
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function stableId(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return `gdelt_${Math.abs(hash).toString(36)}`;
}
