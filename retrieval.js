// Deterministic lexical retrieval. This is BM25-style ranking, not semantic legal reasoning.
const { retrieveClause } = require("./clause-review");
const STOP = new Set(
  "a an and are as at be been by can could do does each for from give has have how i in into is it its me my of on or our please provide show tell than that the their them there these they this those to under us was we were what when where which who will with would you your find identify compare across document documents source sources agreement agreements contract contracts clause clauses provision provisions section sections matter supplied relevant stated applies apply".split(
    " ",
  ),
);
const OVERVIEW = new Set(
  "summarize summarise summary overview brief briefing executive main key point points term terms fact facts entire overall general partner review prepare create write draft generate produce finding findings report reports memo memorandum concise short high level".split(
    " ",
  ),
);
function normalize(token) {
  let value = token.normalize("NFKC").toLowerCase();
  if (value.length > 5 && value.endsWith("ies"))
    return value.slice(0, -3) + "y";
  if (value.length > 4 && value.endsWith("s") && !value.endsWith("ss"))
    return value.slice(0, -1);
  return value;
}
const CONCEPTS = {
  law: ["law", "laws", "jurisdiction", "governing", "governed"],
  assignment: [
    "assignment",
    "assign",
    "assigns",
    "assigned",
    "transfer",
    "transfers",
    "transferred",
    "novation",
    "novate",
  ],
  liability: [
    "liability",
    "liable",
    "cap",
    "capped",
    "caps",
    "limitation",
    "limitations",
    "damages",
  ],
  confidentiality: [
    "confidentiality",
    "confidential",
    "nondisclosure",
    "secrecy",
  ],
  termination: [
    "termination",
    "terminate",
    "terminated",
    "terminates",
    "cancel",
    "cancellation",
    "cancelled",
    "canceled",
  ],
  renewal: [
    "renewal",
    "renew",
    "renews",
    "renewed",
    "extension",
    "extensions",
    "extend",
    "extended",
  ],
  payment: [
    "payment",
    "payments",
    "pay",
    "paid",
    "fee",
    "fees",
    "invoice",
    "invoices",
    "invoicing",
    "billing",
    "remuneration",
  ],
  arbitration: ["arbitration", "arbitral", "arbitrator", "arbitrators"],
  indemnity: ["indemnity", "indemnify", "indemnification", "indemnifies"],
  warranty: ["warranty", "warranties", "warrant", "warrants"],
  audit: ["audit", "audits", "auditing", "inspection", "inspections"],
  retention: [
    "retention",
    "retain",
    "retained",
    "deletion",
    "delete",
    "deleted",
    "erasure",
  ],
  breach: ["breach", "breached", "breaches", "violation"],
  insurance: ["insurance", "insured", "insurer", "coverage"],
  notice: ["notice", "notices", "notification", "notifications"],
  subcontracting: [
    "subcontracting",
    "subcontract",
    "subcontractor",
    "subcontractors",
    "subprocessor",
    "subprocessors",
  ],
};
const aliases = new Map();
for (const [concept, terms] of Object.entries(CONCEPTS))
  for (const term of terms) aliases.set(normalize(term), concept);
const words = (text) =>
  Array.from(text.matchAll(/[\p{L}\p{N}]+/gu), (m) => ({
    term: normalize(m[0]),
    start: m.index,
    end: m.index + m[0].length,
  }));
const bounded = (value, fallback, min, max) =>
  Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
function queryPlan(query) {
  const all = words(query).map((w) => w.term),
    direct = [...new Set(all.filter((w) => !STOP.has(w)))].slice(0, 48);
  const intent = new Set(direct.map((w) => aliases.get(w)).filter(Boolean));
  const weights = new Map();
  for (const term of direct) {
    weights.set(term, 1);
    const concept = aliases.get(term);
    if (concept)
      for (const alias of CONCEPTS[concept]) {
        const normalized = normalize(alias);
        if (!weights.has(normalized)) weights.set(normalized, 0.45);
      }
  }
  const genericOverview =
    all.some((w) =>
      /^(summarize|summarise|summary|overview|brief|briefing)$/.test(w),
    ) && direct.every((w) => OVERVIEW.has(w));
  return { direct, intent, weights, genericOverview };
}
function headingTerms(text) {
  const head = text
    .replace(/^\s*\d+[a-z]?[.)]\s*/iu, "")
    .split(/[.\n:!?]/, 1)[0]
    .slice(0, 100);
  return new Set(words(head).map((w) => w.term));
}
function clipWindow(text, position, maxChars) {
  if (text.length <= maxChars) return { start: 0, end: text.length };
  let start = Math.max(0, position - Math.floor(maxChars / 3));
  start = Math.min(start, text.length - maxChars);
  if (start > 0) {
    const next = text.indexOf(" ", start);
    if (next >= 0 && next - start < 30) start = next + 1;
  }
  let end = Math.min(text.length, start + maxChars);
  if (end < text.length) {
    const previous = text.lastIndexOf(" ", end);
    if (previous > end - 30 && previous > start) end = previous;
  }
  return { start, end };
}
function citation(record, score) {
  return {
    documentId: record.doc.id,
    name: record.doc.name || "Untitled source",
    paragraph: record.paragraph,
    text: record.text,
    startOffset: record.start,
    endOffset: record.end,
    score: Number(score.toFixed(6)),
    ...(record.doc.supersededBy ? { isPreviousVersion: true } : {}),
  };
}
function diversify(records, limit, maxPerDocument) {
  const selected = [],
    docCounts = new Map(),
    paragraphs = new Set();
  while (selected.length < limit) {
    let best = -1,
      value = -Infinity;
    for (let i = 0; i < records.length; i++) {
      const r = records[i],
        key = r.doc.id + ":" + r.paragraph,
        count = docCounts.get(r.doc.id) || 0;
      if (paragraphs.has(key) || count >= maxPerDocument) continue;
      const adjusted = r.score / (1 + 0.18 * count);
      if (adjusted > value) {
        best = i;
        value = adjusted;
      }
    }
    if (best < 0) break;
    const r = records.splice(best, 1)[0];
    selected.push(citation(r, r.score));
    docCounts.set(r.doc.id, (docCounts.get(r.doc.id) || 0) + 1);
    paragraphs.add(r.doc.id + ":" + r.paragraph);
  }
  return selected;
}
function retrieve(query, docs, options = {}) {
  if (typeof query !== "string" || !query.trim() || !Array.isArray(docs))
    return [];
  const clause = retrieveClause(query, docs, options);
  if (clause) return clause;
  const limit = bounded(options.limit, 8, 1, 20),
    maxChars = bounded(options.maxChars, 3000, 128, 4000),
    maxPerDocument = bounded(options.maxPerDocument, 3, 1, 20),
    plan = queryPlan(query);
  if (!plan.direct.length) return [];
  const candidates = [],
    overview = [],
    df = new Map();
  let paragraphs = 0,
    totalLength = 0;
  for (const doc of docs) {
    if (
      !doc ||
      typeof doc.text !== "string" ||
      !doc.id ||
      (!options.includeSuperseded && doc.supersededBy)
    )
      continue;
    const parts = doc.text.split(/\n\s*\n/);
    for (let p = 0; p < parts.length; p++) {
      const original = parts[p];
      if (!original.trim()) continue;
      const tokens = words(original);
      paragraphs++;
      totalLength += tokens.length;
      const relevant = tokens.filter((t) => plan.weights.has(t.term));
      const present = new Set(relevant.map((t) => t.term));
      for (const term of present) df.set(term, (df.get(term) || 0) + 1);
      if (plan.genericOverview && tokens.length >= 8) {
        const range = clipWindow(original, 0, maxChars);
        overview.push({
          doc,
          paragraph: p + 1,
          text: original.slice(range.start, range.end),
          ...range,
          score: 1 / (1 + p * 0.04),
        });
      }
      if (!relevant.length) continue;
      if (
        plan.intent.size &&
        !relevant.some((t) => plan.intent.has(aliases.get(t.term)))
      )
        continue;
      // One window per distinct matched query token captures distant evidence without unbounded chunks.
      const positions = new Map();
      for (const token of relevant)
        if (!positions.has(token.term)) positions.set(token.term, token.start);
      const seen = new Set();
      for (const position of positions.values()) {
        const range = clipWindow(original, position, maxChars),
          key = range.start + ":" + range.end;
        if (seen.has(key)) continue;
        seen.add(key);
        const snippet = original.slice(range.start, range.end),
          snippetTokens = words(snippet),
          tf = new Map();
        for (const t of snippetTokens)
          if (plan.weights.has(t.term))
            tf.set(t.term, (tf.get(t.term) || 0) + 1);
        if (
          plan.intent.size &&
          ![...tf.keys()].some((t) => plan.intent.has(aliases.get(t)))
        )
          continue;
        candidates.push({
          doc,
          paragraph: p + 1,
          text: snippet,
          ...range,
          len: snippetTokens.length,
          tf,
          heading: range.start === 0 ? headingTerms(original) : new Set(),
        });
      }
    }
  }
  if (plan.genericOverview) return diversify(overview, limit, maxPerDocument);
  const average = paragraphs ? Math.max(1, totalLength / paragraphs) : 1;
  for (const record of candidates) {
    let score = 0,
      matched = 0;
    for (const [term, weight] of plan.weights) {
      const count = record.tf.get(term) || 0;
      if (!count) continue;
      const idf = Math.log(
        1 +
          (paragraphs - (df.get(term) || 0) + 0.5) /
            ((df.get(term) || 0) + 0.5),
      );
      score +=
        (weight * idf * (count * 2.2)) /
        (count + 1.2 * (0.25 + (0.75 * record.len) / average));
      if (record.heading.has(term)) score += weight * idf * 0.7;
      if (plan.direct.includes(term)) matched++;
    }
    const plain = record.text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ");
    const directPhrase = plan.direct.join(" ");
    if (plan.direct.length > 1 && plain.includes(directPhrase)) score += 1.8;
    score *= 1 + Math.min(matched, 4) * 0.1;
    record.score = score;
  }
  return diversify(
    candidates.filter((r) => r.score > 0),
    limit,
    maxPerDocument,
  );
}
module.exports = { retrieve };
