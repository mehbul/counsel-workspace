const { createHash } = require("node:crypto");
const { readSource, date } = require("./legal-sources");
const ORIGIN = "https://www.ecfr.gov";
const NOTICE =
  "eCFR is an editorial compilation of US federal regulations, not the official legal edition. Results are dated snapshots and may omit appendices, reserved or removed provisions. Verify the linked source, annual CFR, Federal Register amendments and effective dates; current legal force and subsequent treatment are not verified.";
const validSection = (value) =>
  typeof value === "string" &&
  /^\d{1,6}\.\d{1,6}[a-zA-Z0-9-]{0,12}$/.test(value);
const validTitle = (value) =>
  Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 50;
function plain(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const code =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(
      /&(lt|gt|amp|quot|apos|nbsp);/g,
      (_, name) =>
        ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " })[name],
    );
}
async function titleDates(options) {
  const data = await readSource(
    ORIGIN + "/api/versioner/v1/titles.json",
    200000,
    options,
  );
  if (!Array.isArray(data.titles)) throw Error("Invalid eCFR title metadata.");
  const titles = data.titles.filter(
    (t) => !t.reserved && validTitle(t.number) && date(t.up_to_date_as_of),
  );
  if (!titles.length) throw Error("eCFR source date unavailable.");
  return titles;
}
async function searchEcfr(query, options = {}) {
  if (typeof query !== "string" || !query.trim() || query.length > 500)
    throw Error("Use a search query of 1–500 characters.");
  if (options.title !== undefined && !validTitle(options.title))
    throw Error("Use a CFR title from 1 through 50.");
  const page = options.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 50)
    throw Error("Invalid results page.");
  const titles = await titleDates(options),
    selected = options.title
      ? titles.filter((t) => Number(t.number) === Number(options.title))
      : titles;
  if (!selected.length) throw Error("Selected CFR title is unavailable.");
  const availableAsOf = selected.map((t) => t.up_to_date_as_of).sort()[0],
    asOf = options.asOf || availableAsOf;
  if (!date(asOf) || asOf > availableAsOf)
    throw Error("Requested snapshot date exceeds source availability.");
  const url = new URL("/api/search/v1/results", ORIGIN);
  for (const [key, value] of Object.entries({
    query: query.trim(),
    per_page: 20,
    page,
    date: asOf,
    order: "relevance",
  }))
    url.searchParams.set(key, String(value));
  if (options.title)
    url.searchParams.set("hierarchy[title]", String(options.title));
  const data = await readSource(url.href, 2000000, options);
  if (
    !Array.isArray(data.results) ||
    !Number.isSafeInteger(data.meta?.total_count) ||
    data.meta.total_count < 0
  )
    throw Error("Invalid eCFR result list.");
  const results = data.results.slice(0, 20).flatMap((item) => {
    const title = Number(item.hierarchy?.title),
      section = item.hierarchy?.section;
    if (
      !validTitle(title) ||
      !validSection(section) ||
      item.type !== "Section" ||
      item.reserved ||
      item.removed ||
      (options.title && title !== Number(options.title))
    )
      return [];
    return [
      {
        provider: "ecfr",
        title: plain(item.headings?.section || `${title} CFR ${section}`).slice(
          0,
          1500,
        ),
        cfrTitle: title,
        section,
        asOf,
        availableAsOf,
        type: "Dated eCFR section",
        citation: `${title} CFR ${section}`,
        documentNumber: `ecfr:${title}:${section}:${asOf}`,
        publicationDate: date(item.starts_on) ? item.starts_on : null,
        effectiveOn: null,
        agencies: [],
        abstract: plain(item.full_text_excerpt).slice(0, 12000),
        url: `${ORIGIN}/on/${asOf}/title-${title}/section-${section}`,
        officialXml: `${ORIGIN}/api/versioner/v1/full/${asOf}/title-${title}.xml?part=${section.split(".")[0]}&section=${section}`,
        officialPdf: null,
      },
    ];
  });
  return {
    provider: "ecfr",
    jurisdiction: "US federal regulations",
    query: query.trim(),
    page,
    total: data.meta.total_count,
    nextPage: page < 50 && page < data.meta.total_pages ? page + 1 : null,
    results,
    asOf,
    availableAsOf,
    omittedOnPage: Math.min(data.results.length, 20) - results.length,
    retrievedAt: new Date().toISOString(),
    notice: NOTICE,
  };
}
async function ecfrDocument(title, section, asOf, options = {}) {
  if (!validTitle(title) || !validSection(section) || !date(asOf))
    throw Error("Invalid eCFR section or date.");
  title = Number(title);
  const url = new URL(
    `/api/versioner/v1/full/${asOf}/title-${title}.xml`,
    ORIGIN,
  );
  url.searchParams.set("part", section.split(".")[0]);
  url.searchParams.set("section", section);
  const xml = await readSource(url.href, 5 * 1024 * 1024, {
      ...options,
      xml: true,
    }),
    value = xml.toString("utf8");
  // No DTD, external entities or upstream links are interpreted or fetched.
  const root = value.match(/<DIV8\b([^>]*)>/);
  if (
    /<!DOCTYPE|<!ENTITY/i.test(value) ||
    !root ||
    !new RegExp(
      '\\bN="' + section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"',
    ).test(root[1]) ||
    !/\bTYPE="SECTION"/.test(root[1]) ||
    !value.trim().endsWith("</DIV8>")
  )
    throw Error("eCFR returned an unexpected section XML rendition.");
  const text = plain(
    value
      .replace(/<\?xml[^>]*>/g, "")
      .replace(/<\/(?:HEAD|P|ROW|TABLE|DIV\d)>/g, "\n\n")
      .replace(/<\/(?:ENTRY|TD)>/g, " | "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw Error("No section text available.");
  return {
    text,
    original: xml,
    mime: "application/xml",
    sha256: createHash("sha256").update(xml).digest("hex"),
    source: {
      provider: "ecfr",
      cfrTitle: title,
      section,
      asOf,
      documentNumber: `ecfr:${title}:${section}:${asOf}`,
      citation: `${title} CFR ${section}`,
      title: plain(
        value.match(/<HEAD>([\s\S]*?)<\/HEAD>/)?.[1] ||
          `${title} CFR ${section}`,
      ).slice(0, 1500),
      url: `${ORIGIN}/on/${asOf}/title-${title}/section-${section}`,
      officialXml: url.href,
    },
    notice: NOTICE,
  };
}
module.exports = { searchEcfr, ecfrDocument, NOTICE, plain };
