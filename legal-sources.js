const { createHash } = require("node:crypto");
const ORIGIN = "https://www.federalregister.gov";
const NOTICE =
  "Federal Register publication research covers US federal publications only. Search text is an informational rendition. Verify the linked official edition and effective dates; publication does not establish current legal force or subsequent treatment.";
const documentNumber = (value) =>
  typeof value === "string" && /^\d{4}-\d{3,8}$/.test(value);
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
async function readSource(url, maxBytes, options = {}) {
  const response = await (options.fetch || global.fetch)(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: options.pdf
        ? "application/pdf"
        : options.xml
          ? "application/xml"
          : "application/json",
      "User-Agent": "Counsel-Workspace/1.0 (public legal source research)",
    },
  });
  if (!response.ok) throw Error("Public source unavailable. Retry later.");
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw Error("Public source response is too large.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > maxBytes) throw Error("Public source response is too large.");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  if (options.xml) return data;
  if (options.pdf) {
    if (!data.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw Error("The official source did not return a PDF.");
    return data;
  }
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    throw Error("Public source returned an invalid response.");
  }
}
function normalizeDocument(d) {
  if (
    !d ||
    !documentNumber(d.document_number) ||
    !date(d.publication_date) ||
    typeof d.title !== "string"
  )
    return null;
  const result = {
    documentNumber: d.document_number,
    title: d.title.slice(0, 1500),
    type: String(d.type || "Unspecified publication").slice(0, 100),
    abstract: typeof d.abstract === "string" ? d.abstract.slice(0, 12000) : "",
    publicationDate: d.publication_date,
    effectiveOn: date(d.effective_on) ? d.effective_on : null,
    citation: typeof d.citation === "string" ? d.citation.slice(0, 150) : null,
    agencies: Array.isArray(d.agencies)
      ? d.agencies
          .slice(0, 10)
          .map((a) => String(a.name || a.raw_name || "").slice(0, 200))
      : [],
    url: `${ORIGIN}/documents/${d.publication_date.replaceAll("-", "/")}/${d.document_number}`,
    officialPdf: null,
  };
  const expected = `https://www.govinfo.gov/content/pkg/FR-${d.publication_date}/pdf/${d.document_number}.pdf`;
  // Never follow an upstream-provided arbitrary URL, credential, query or redirect.
  if (d.pdf_url === expected) result.officialPdf = expected;
  return result;
}
async function searchFederalRegister(query, options = {}) {
  if (typeof query !== "string" || !query.trim() || query.length > 500)
    throw Error("Use a search query of 1–500 characters.");
  const page = options.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 50)
    throw Error("Invalid results page.");
  const url = new URL("/api/v1/documents.json", ORIGIN);
  url.searchParams.set("conditions[term]", query.trim());
  url.searchParams.set("per_page", "20");
  url.searchParams.set("page", String(page));
  url.searchParams.set("order", "newest");
  for (const [key, value] of [
    ["gte", options.from],
    ["lte", options.to || new Date().toISOString().slice(0, 10)],
  ]) {
    if (value) {
      if (!date(value)) throw Error("Use a valid publication date.");
      url.searchParams.set(`conditions[publication_date][${key}]`, value);
    }
  }
  if (options.from && options.to && options.from > options.to)
    throw Error("Start date must precede end date.");
  const data = await readSource(url.href, 2000000, options);
  if (
    !Array.isArray(data.results) ||
    !Number.isSafeInteger(data.count) ||
    data.count < 0
  )
    throw Error("Public source returned an invalid result list.");
  const results = data.results
    .slice(0, 20)
    .map(normalizeDocument)
    .filter(Boolean);
  return {
    provider: "federal-register",
    jurisdiction: "US federal",
    query: query.trim(),
    page,
    total: data.count,
    nextPage: page < 50 && data.next_page_url ? page + 1 : null,
    results,
    retrievedAt: new Date().toISOString(),
    notice: NOTICE,
  };
}
async function officialDocument(number, options = {}) {
  if (!documentNumber(number))
    throw Error("Invalid Federal Register document number.");
  const data = await readSource(
    `${ORIGIN}/api/v1/documents/${number}.json`,
    2000000,
    options,
  );
  const source = normalizeDocument(data);
  if (!source || source.documentNumber !== number || !source.officialPdf)
    throw Error("A matching official PDF is unavailable.");
  const pdf = await readSource(source.officialPdf, 20 * 1024 * 1024, {
    ...options,
    pdf: true,
  });
  return {
    source,
    pdf,
    sha256: createHash("sha256").update(pdf).digest("hex"),
    notice: NOTICE,
  };
}
module.exports = {
  searchFederalRegister,
  officialDocument,
  normalizeDocument,
  readSource,
  date,
  NOTICE,
};
