// Deterministic reference integrity checks. This is not a legal or entailment evaluator.
const LIMITATION =
  "This checks source availability, exact quotations and reference format only. It does not establish legal correctness, completeness, source authenticity or currency, or whether evidence supports a claim.";

function withoutCode(text) {
  return text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, (value) =>
      value.replace(/[^\n]/g, " "),
    )
    .replace(/`[^`\n]*`/g, "");
}

function references(text) {
  const normalized = text.normalize("NFKC");
  const result = [];
  // Do not interpret markdown links, images, escaped markers or nested brackets as citations.
  const pattern =
    /(?<![\\\[!])\[(\d{1,9}(?:\s*,\s*\d{1,9})*)\](?![\](])|【(\d{1,9})】/g;
  for (const match of normalized.matchAll(pattern)) {
    for (const number of (match[1] || match[2]).split(","))
      result.push(Number(number.trim()));
  }
  return result;
}

function isNotice(text) {
  const notice = text.trim();
  // Only complete, recognized notices may be omitted from paragraph coverage.
  // A notice prefix must not hide a substantive claim appended to that paragraph.
  return (
    /^Local evidence search\.(?: These are source excerpts, not an AI-generated legal opinion\.)?$/i.test(
      notice,
    ) ||
    /^No matching evidence found in the selected documents\.(?: Try a specific clause or upload relevant documents\.)?$/i.test(
      notice,
    ) ||
    /^(?:no (?:matching |relevant |supporting )?(?:evidence|sources?|documents?) (?:found|available|provided)|not found in (?:the )?(?:document|supplied sources)|insufficient evidence)\.?$/i.test(
      notice,
    )
  );
}

function isHeading(text) {
  if (text.includes("\n")) return false;
  if (/^#{1,6}\s/.test(text)) return true;
  if (/^\[\d+\]\s*[^.!?]*$/.test(text)) return true;
  const words = text.match(/\p{L}+/gu) || [];
  if (text.endsWith(":") && words.length <= 18) return true;
  if (words.length < 6 && text === text.toUpperCase()) return true;
  return false;
}

function isSubstantive(text, refs) {
  if (isNotice(text) || isHeading(text)) return false;
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  if (refs.length && words.length >= 3) return true;
  return (
    words.length >= 8 ||
    (words.length >= 3 &&
      (/[.!?;]/.test(text) ||
        /\b(?:is|are|was|were|shall|must|may|requires?|provides?|allows?|governs?|exceeds?|includes?)\b/i.test(
          text,
        )))
  );
}

function checkEvidence(text, citations, docs, options = {}) {
  const mode = ["excerpts", "linked_sources"].includes(options.mode)
    ? options.mode
    : "analysis";
  const checkedOutputText = mode !== "linked_sources";
  const issues = [];
  const add = (code, severity, message, details = {}) => {
    if (issues.length < 200)
      issues.push({ code, severity, message, ...details });
    else issuesTruncated = true;
  };
  let issuesTruncated = false;
  const originalText = typeof text === "string" ? text : "";
  if (checkedOutputText && typeof text !== "string")
    add("invalid_output", "error", "The output is not text.");
  if (checkedOutputText && originalText.length > 1000000)
    add(
      "output_limit",
      "error",
      "Only the first million characters were checked.",
    );
  const output = originalText.slice(0, 1000000);
  const refs = Array.isArray(citations) ? citations : [];
  if (!Array.isArray(citations))
    add("invalid_citations", "error", "Citation data is not a list.");
  if (refs.length > 1000)
    add(
      "citation_limit",
      "error",
      "Only the first 1,000 citations were checked.",
    );
  const sources = Array.isArray(docs) ? docs : [];
  const byId = new Map();
  const ambiguous = new Set();
  for (const source of sources) {
    if (!source || typeof source.id !== "string") continue;
    if (byId.has(source.id)) ambiguous.add(source.id);
    else byId.set(source.id, source);
  }
  const paragraphCache = new Map();
  const citationChecks = [];
  let validCitationCount = 0;
  for (const [offset, reference] of refs.slice(0, 1000).entries()) {
    const index = offset + 1;
    const result = {
      index,
      documentId: reference?.documentId,
      paragraph: reference?.paragraph,
      status: "invalid",
    };
    citationChecks.push(result);
    if (
      !reference ||
      typeof reference.documentId !== "string" ||
      !Number.isInteger(reference.paragraph) ||
      reference.paragraph < 1 ||
      typeof reference.text !== "string" ||
      !reference.text.trim()
    ) {
      add(
        "invalid_citation",
        "error",
        "The citation needs a document, positive paragraph number and nonempty quotation.",
        { citation: index },
      );
      continue;
    }
    const source = byId.get(reference.documentId);
    if (!source || typeof source.text !== "string") {
      add(
        "source_missing",
        "error",
        "The cited source version is unavailable in the authorized context.",
        { citation: index, documentId: reference.documentId },
      );
      continue;
    }
    if (ambiguous.has(reference.documentId)) {
      add(
        "source_ambiguous",
        "error",
        "More than one supplied source has this document version ID.",
        { citation: index, documentId: reference.documentId },
      );
      continue;
    }
    if (!paragraphCache.has(source.id))
      paragraphCache.set(source.id, source.text.split(/\n\s*\n/));
    const paragraph = paragraphCache.get(source.id)[reference.paragraph - 1];
    if (paragraph === undefined) {
      add(
        "paragraph_missing",
        "error",
        "The cited paragraph does not exist in this source version.",
        {
          citation: index,
          documentId: source.id,
          paragraph: reference.paragraph,
        },
      );
      continue;
    }
    if (!paragraph.includes(reference.text)) {
      add(
        "quote_mismatch",
        "error",
        "The quotation does not match the cited source paragraph.",
        {
          citation: index,
          documentId: source.id,
          paragraph: reference.paragraph,
        },
      );
      continue;
    }
    result.status = "matches";
    validCitationCount++;
    if (
      typeof reference.name === "string" &&
      typeof source.name === "string" &&
      reference.name !== source.name
    )
      add(
        "source_name_mismatch",
        "warning",
        "The displayed source name differs from the current source record.",
        { citation: index, documentId: source.id },
      );
    if (source.supersededBy && !options.allowSuperseded)
      add(
        "source_superseded",
        "warning",
        "The citation matches a retained previous version; check whether the newer version should be used.",
        {
          citation: index,
          documentId: source.id,
          supersededBy: source.supersededBy,
        },
      );
  }

  const valid = new Set(
    citationChecks.filter((r) => r.status === "matches").map((r) => r.index),
  );
  const used = new Set();
  const invalidReferences = new Set();
  const uncitedParagraphs = [];
  let substantiveParagraphCount = 0;
  let citedParagraphCount = 0;
  let uncitedParagraphCount = 0;
  let inlineReferenceCount = 0;
  let bibliography = false;
  const blocks = checkedOutputText ? output.split(/\n\s*\n/) : [];
  for (const [offset, raw] of blocks.entries()) {
    const paragraph = offset + 1;
    const block = mode === "excerpts" ? raw.trim() : withoutCode(raw).trim();
    if (!block) continue;
    const firstLine = block.split("\n")[0].trim();
    if (
      /^(?:#{1,6}\s*)?(?:sources|references|bibliography|citations|source list)\s*:?$/i.test(
        firstLine,
      )
    ) {
      bibliography = true;
      continue;
    }
    if (bibliography && /^#{1,6}\s/.test(firstLine)) bibliography = false;
    if (bibliography) {
      // A numbered source-list entry is not a claim citation. Do not hide arbitrary
      // substantive prose just because it appears after a Sources heading.
      if (/^\[\d+\]\s/.test(firstLine)) continue;
      if (isSubstantive(block, references(block)))
        add(
          "bibliography_prose",
          "warning",
          "Substantive prose appears in the source-list section; review its attribution separately.",
          { paragraph },
        );
      continue;
    }
    if (isNotice(block) || isHeading(block)) continue;

    if (mode === "excerpts") {
      const heading = firstLine.normalize("NFKC").match(/^\[(\d+)\]\s*(.*)$/);
      const body = raw.slice(raw.indexOf("\n") + 1).trim();
      if (heading && raw.includes("\n")) {
        const index = Number(heading[1]);
        const reference = refs[index - 1];
        inlineReferenceCount++;
        used.add(index);
        substantiveParagraphCount++;
        if (reference && body === reference.text.trim() && valid.has(index)) {
          citedParagraphCount++;
          if (reference.name && heading[2] !== reference.name)
            add(
              "excerpt_label_mismatch",
              "warning",
              "The excerpt label differs from its citation source name.",
              { paragraph, citation: index },
            );
          continue;
        }
        add(
          "excerpt_mismatch",
          "error",
          "This displayed excerpt does not match a valid quoted source.",
          { paragraph, citation: index },
        );
        uncitedParagraphCount++;
        if (uncitedParagraphs.length < 50)
          uncitedParagraphs.push({ paragraph, text: body.slice(0, 350) });
        continue;
      }
    }

    const normalized = block.normalize("NFKC");
    if (/(?<![\\\[!])\[\d+\s*[-–]\s*\d+\](?![\](])/.test(normalized))
      add(
        "unsupported_reference_style",
        "warning",
        "Use individual numbered references such as [1] [2], rather than a citation range.",
        { paragraph },
      );
    const numbers = references(block);
    inlineReferenceCount += numbers.length;
    for (const number of numbers) {
      if (number < 1 || number > refs.length) {
        if (!invalidReferences.has(number))
          add(
            "reference_out_of_range",
            "error",
            "The output points to a citation number that was not supplied.",
            { reference: number, paragraph },
          );
        invalidReferences.add(number);
      } else used.add(number);
    }
    if (!isSubstantive(block, numbers)) continue;
    substantiveParagraphCount++;
    if (numbers.some((number) => valid.has(number))) citedParagraphCount++;
    else {
      uncitedParagraphCount++;
      if (uncitedParagraphs.length < 50)
        uncitedParagraphs.push({ paragraph, text: block.slice(0, 350) });
      add(
        "uncited_paragraph",
        "warning",
        "A substantive output paragraph has no matching inline source reference.",
        { paragraph },
      );
    }
  }
  if (!refs.length)
    add(
      "no_sources",
      "warning",
      "No source citations were supplied for this output.",
    );
  if (checkedOutputText && !output.trim())
    add("empty_output", "warning", "There is no output text to check.");
  else if (checkedOutputText && !substantiveParagraphCount && !isNotice(output))
    add(
      "no_substantive_content",
      "warning",
      "No substantive body content was found outside headings, code and source lists.",
    );
  const requiresReview = issues.some(
    (i) => i.severity === "warning" || i.severity === "error",
  );
  return {
    status: !refs.length
      ? "no_sources"
      : requiresReview
        ? "needs_review"
        : "references_valid",
    mode,
    checkedOutputText,
    citationCount: refs.length,
    validCitationCount,
    invalidCitationCount: refs.length - validCitationCount,
    usedCitationCount: checkedOutputText
      ? [...used].filter((index) => index > 0 && index <= refs.length).length
      : null,
    unusedCitationCount: checkedOutputText
      ? refs.length -
        [...used].filter((index) => index > 0 && index <= refs.length).length
      : null,
    inlineReferenceCount: checkedOutputText ? inlineReferenceCount : null,
    substantiveParagraphCount: checkedOutputText
      ? substantiveParagraphCount
      : null,
    citedParagraphCount: checkedOutputText ? citedParagraphCount : null,
    uncitedParagraphCount: checkedOutputText ? uncitedParagraphCount : null,
    invalidReferences: [...invalidReferences],
    citationChecks,
    uncitedParagraphs,
    issues,
    issuesTruncated,
    limitation: checkedOutputText
      ? LIMITATION
      : "Only linked source availability and exact quotations were checked. The cell interpretation, inline references and output paragraph coverage were not validated. " +
        LIMITATION,
  };
}

module.exports = { checkEvidence };
