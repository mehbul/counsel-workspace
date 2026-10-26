// Deterministic clause-level retrieval. Pattern anchors return exact source
// spans. Finding no anchor produces no evidence; it is never proof that a
// clause is legally absent.
const MAX_SEGMENT = 1200;
const DATE =
  /(?:\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b)/;
const ABBREVIATION =
  /(?:\b(?:Inc|Ltd|Co|Corp|Corporation|Company|No|Nos|Sec|Section|Art|Article|Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|v|e\.g|i\.e|etc|approx|Dept|Univ|U\.S|U\.S\.A|LLC|LP|LLP|R\.R)|\b[A-Z])$/;
const HEADING =
  /^(?:(?:section|article|clause)\s+)?(?:\d+(?:\.\d+)*[.)]?|[A-Z])[\s.)-]*[A-Z][^.!?]{1,70}$/i;

const bounded = (value, fallback, min, max) =>
  Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;

function paragraphRanges(text) {
  const result = [];
  let start = 0;
  for (const match of text.matchAll(/\n\s*\n/g)) {
    result.push({
      start,
      end: match.index,
      text: text.slice(start, match.index),
    });
    start = match.index + match[0].length;
  }
  result.push({ start, end: text.length, text: text.slice(start) });
  return result;
}

function sentences(text) {
  const result = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character !== "." && character !== "!" && character !== "?") continue;
    if (ABBREVIATION.test(text.slice(Math.max(0, i - 12), i + 1))) continue;
    let close = i + 1;
    while (close < text.length && /["'”’)\]]/.test(text[close])) close++;
    if (close >= text.length || !/\s/.test(text[close])) continue;
    let next = close;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (next >= text.length || !/[A-Z0-9(“"']/.test(text[next])) continue;
    result.push({ start, end: close });
    start = next;
    i = next - 1;
  }
  if (start < text.length) result.push({ start, end: text.length });
  return result;
}

function segments(paragraph) {
  const parts = [];
  for (const line of paragraph.matchAll(/[^\n]+/g)) {
    const base = line.index;
    for (const sentence of sentences(line[0])) {
      let start = base + sentence.start,
        end = base + sentence.end;
      while (start < end && /\s/.test(paragraph[start])) start++;
      while (end > start && /\s/.test(paragraph[end - 1])) end--;
      if (start < end) parts.push({ start, end });
    }
  }
  const merged = [];
  for (let i = 0; i < parts.length; i++) {
    let current = { ...parts[i] };
    while (i + 1 < parts.length) {
      const text = paragraph.slice(current.start, current.end);
      const heading =
        text.length <= 80 &&
        (HEADING.test(text) ||
          /:$/.test(text) ||
          /^[A-Z0-9 '’&()/,.-]{6,}$/.test(text) ||
          text.length < 40);
      const next = parts[i + 1];
      if (!heading || next.end - current.start > MAX_SEGMENT) break;
      current = { start: current.start, end: next.end };
      i++;
    }
    merged.push({
      ...current,
      text: paragraph.slice(current.start, current.end),
    });
  }
  return merged;
}

const CATEGORIES = [
  {
    id: "document-name",
    label: "Document Name",
    metadata: "title",
    queries: [
      /document name/i,
      /name of (?:the|this) (?:contract|agreement|document)/i,
      /title of (?:the|this) (?:contract|agreement|document)/i,
    ],
    maxResults: 1,
  },
  {
    id: "parties",
    label: "Parties",
    metadata: "parties",
    queries: [
      /\bpart(?:y|ies)\b.*\b(?:contract|agreement)\b/i,
      /\bwho are the parties\b/i,
      /\bname of (?:the )?part(?:y|ies)\b/i,
      /\bsignatories\b/i,
    ],
    intro:
      /\b(?:by and between|by and among|is entered into by|entered into (?:by|between|among)|made and (?:entered into )?(?:effective|as of).{0,120}\bbetween|is dated as of.{0,60}\bbetween|between)\b/i,
    entity:
      /\b(?:Inc|Incorporated|LLC|L\.L\.C|Ltd|Limited|Corp|Corporation|Company|Co\.|Bank|Partners|Partnership|Trust|Association|Foundation|City of|County of|State of|University|Holdings|Group|N\.A)\b/i,
    maxResults: 2,
  },
  {
    id: "agreement-date",
    label: "Agreement Date",
    metadata: "date",
    queries: [
      /agreement date/i,
      /date of (?:the|this) (?:contract|agreement)/i,
      /when was .{0,30}(?:signed|executed|dated|entered into)/i,
    ],
    dateContext: [
      /\bdated(?: as of)?\b/i,
      /\bmade and (?:entered into )?(?:effective|as of)\b/i,
      /\bentered into (?:as of|on)\b/i,
      /\bexecuted(?: as of| on)?\b/i,
      /\bas of\b/i,
    ],
    maxResults: 1,
    top: true,
    signature: true,
  },
  {
    id: "effective-date",
    label: "Effective Date",
    metadata: "date",
    queries: [
      /effective date/i,
      /when (?:does|will) .{0,40}(?:become|take) effective/i,
      /effective as of/i,
    ],
    dateContext: [
      /\beffective (?:as of|on|from|date)\b/i,
      /\bmade and effective\b/i,
      /\bshall become effective\b/i,
      /\bcommence(?:s|ment)? (?:on|as of)\b/i,
      /\b(?:term|agreement|contract)\b.{0,80}\b(?:begin|commence|start)(?:s|ed|ing)? (?:on|as of)\b/i,
      /\bEffective Date\b/,
    ],
    maxResults: 1,
    top: true,
  },
  {
    id: "expiration-date",
    label: "Expiration Date",
    metadata: "date",
    queries: [
      /expiration date/i,
      /expiry date/i,
      /when (?:does|will) .{0,40}(?:expire|end)/i,
      /initial term.{0,40}(?:expire|end)/i,
    ],
    dateContext: [
      /\bexpir(?:e|es|ation|y)\b/i,
      /\bend(?:s|ing)? (?:on|of the (?:initial )?term)\b/i,
      /\b(?:initial |renewal )?terms?\b.{0,50}\b(?:end(?:s|ing)?|expir(?:e|es|ation|y))\b/i,
      /\bterminat(?:e|es|ing) on\b/i,
      /\bthrough\b/i,
    ],
    maxResults: 1,
  },
  {
    id: "renewal-term",
    label: "Renewal Term",
    metadata: "renewal",
    queries: [
      /renewal term/i,
      /\brenewal\b/i,
      /\brenew(?:s|ed)?\b/i,
      /automatic(?:ally)? (?:extend|renew)/i,
    ],
    strong: [
      /\brenew(?:s|ed|al)?\b/i,
      /\bextend(?:s|ed|ing)? (?:for|by) (?:a |an |one |two |three |\d)/i,
      /\bsuccessive (?:term|period|renewal)/i,
      /\bfurther (?:term|period|year)/i,
      /\badditional (?:term|period|year)/i,
      /\bautomatically (?:extend|renew)/i,
    ],
    maxResults: 2,
  },
  {
    id: "renewal-notice",
    label: "Notice Period To Terminate Renewal",
    metadata: "renewal",
    queries: [
      /notice period.{0,40}renew/i,
      /renewal notice/i,
      /notice.{0,40}(?:terminate|prevent).{0,40}renew/i,
      /notice of non-?renewal/i,
    ],
    strong: [
      /\b(?:renew|extension|extend).{0,160}(?:notice|not less than|no later than)/i,
      /\bnotice.{0,160}(?:renew|extension|not to renew|non-?renewal)/i,
      /\bnon-?renewal notice\b/i,
    ],
    require: [/\bnotice\b/i],
    maxResults: 2,
  },
  {
    id: "governing-law",
    label: "Governing Law",
    queries: [
      /governing law/i,
      /applicable law/i,
      /choice of law/i,
      /which .{0,30}law (?:governs|applies)/i,
      /\bjurisdiction\b/i,
      /governed by/i,
    ],
    strong: [
      /\bgoverned by (?:and construed (?:in accordance with|under) )?(?:the )?laws?\b/i,
      /\bconstrued (?:in accordance with|under) (?:the )?laws?\b/i,
      /\bgoverning law\b/i,
      /\blaws? of the State of [A-Z]/i,
      /\blaws? of (?:the )?(?:United States|England|Wales|New York|California|Texas|Delaware|Massachusetts|Florida|Illinois|Pennsylvania|Canada|Ontario|Quebec|Australia|Singapore|China|Japan|Germany|France|Switzerland|Netherlands|Ireland|Bermuda|Cayman)\b/i,
      /\bsubject to the (?:exclusive )?jurisdiction of\b/i,
    ],
    exclude: [
      /\blawyer\b|\blaw firm\b/i,
      /\b(?:organized|incorporated|existing|formed) under the laws\b/i,
      /\bqualified to do business\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "most-favored-nation",
    label: "Most Favored Nation",
    queries: [
      /most favou?red nation/i,
      /\bMFN\b/,
      /same or better terms/i,
      /no less favou?rable (?:terms|than)/i,
      /as favou?rable as/i,
    ],
    strong: [
      /\bmost favou?red nation\b/i,
      /\bMFN\b/,
      /\bsame or better (?:terms|prices?|conditions?)\b/i,
      /\bno less favou?rable (?:terms|than)\b/i,
      /\bas favou?rable as .{0,60}(?:offered|provided|given) to\b/i,
      /\bcomparable to .{0,40}(?:offered|provided) to (?:any )?other\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "non-compete",
    label: "Non-Compete",
    queries: [
      /non-?compet(?:e|ition)/i,
      /not to compete/i,
      /covenant not to compete/i,
      /compet(?:e|ing) with/i,
      /competitive (?:business|activity|restriction)/i,
    ],
    strong: [
      /\bnon-?compet(?:e|ition|itive)\b/i,
      /\bcovenant not to compete\b/i,
      /\bshall not (?:directly or indirectly )?(?:compete|engage in competition)\b/i,
      /\brestrict(?:ed|ion) .{0,50}(?:compete|competition|competing business)\b/i,
      /\bcompete with .{0,80}(?:business|company|party|counterparty)\b/i,
      /\bengage in (?:any )?(?:business|activity) .{0,60}(?:competitive|competes?)\b/i,
      /\b(?:will|shall|may) not (?:enter into|engage in|participate in|deal with|do business with)\b.{0,140}\b(?:compet(?:ing|itor|itors)|competitive)\b/i,
    ],
    exclude: [
      /non-?compet(?:e|ition).{0,40}(?:shall not apply|does not apply|not applicable)/i,
    ],
    maxResults: 2,
  },
  {
    id: "exclusivity",
    label: "Exclusivity",
    queries: [
      /exclusiv(?:e|ity|ely)/i,
      /exclusive dealing/i,
      /requirements? contract/i,
      /sole (?:supplier|provider|distributor)/i,
    ],
    strong: [
      /\bexclusiv(?:e|ely) (?:right|rights|license|licence|arrangement|dealing|distributor|distributorship|supplier|provider|basis|engagement|territory)\b/i,
      /\bappoint(?:s|ed)? .{0,80}exclusiv(?:e|ely)\b/i,
      /\bshall not .{0,80}(?:sell|supply|distribute|market|license|licence).{0,80}(?:third part|competitor|counterparty)\b/i,
      /\b(?:purchase|procure|obtain) (?:all|its entire) (?:requirements?|needs?)\b/i,
      /\bexclusive (?:dealings?|territory|rights?)\b/i,
    ],
    exclude: [
      /\bexclusive jurisdiction\b|\bexclusive venue\b|\bexclusive remedy\b|\bsole and exclusive\b|\bexclusive of\b|\bexclusive discretion\b|\bexclusive ownership\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "no-solicit-customers",
    label: "No-Solicit Of Customers",
    queries: [
      /no-?solicit(?:ation)? .{0,40}(?:customer|client)/i,
      /solicit(?:ation)? .{0,40}(?:customer|client|partner)/i,
      /not .{0,40}solicit .{0,40}(?:customer|client)/i,
    ],
    strong: [
      /\bsolicit(?:ation)? .{0,60}(?:customers?|clients?|partners?)\b/i,
      /\b(?:customers?|clients?|partners?) .{0,60}solicit/i,
      /\bdivert .{0,50}(?:customers?|clients?|business)\b/i,
      /\bnon-?solicit(?:ation)? .{0,40}(?:customers?|clients?)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "competitive-restriction-exception",
    label: "Competitive Restriction Exception",
    queries: [
      /(?:exception|carve-?out|exclusion).{0,40}(?:non-?compet|exclusiv|solicit)/i,
      /competitive restriction exception/i,
      /permitted .{0,40}(?:compet|exclusiv|solicit)/i,
    ],
    strong: [
      /\b(?:nothing|notwithstanding).{0,160}(?:restrict|prevent|prohibit).{0,160}(?:compet|exclusiv|solicit)/i,
      /\b(?:exception|carve-?out|exclusion).{0,100}(?:compet|exclusiv|solicit)/i,
      /\b(?:shall not|does not) (?:apply|restrict|prevent|prohibit).{0,120}(?:compet|exclusiv|solicit)/i,
      /\b(?:provided(?:,| that)?|notwithstanding (?:the foregoing|anything)|however)\b.{0,180}\b(?:will|shall|does|do|has|have) not\b.{0,120}\b(?:restrict|prevent|prohibit|apply|control|influence)\b/i,
      /\b(?:will|shall|does|do) not\b.{0,80}\b(?:restrict|prevent|prohibit)\b.{0,160}\b(?:competing|competitor|competitive|exclusiv|solicit)\b/i,
      /\bno (?:control|influence)(?: or (?:control|influence))? over\b.{0,160}\b(?:compet(?:ing|itor|itors)|exclusiv|solicit)\b/i,
      /\b(?:expressly )?(?:excluded|exempted|carved out) from (?:this|the) (?:provision|restriction|section)\b/i,
      /\bpassive (?:investment|ownership)\b/i,
    ],
    require: [/\b(?:compet|exclusiv|solicit|investment)/i],
    maxResults: 2,
    maxPerParagraph: 2,
  },
  {
    id: "no-solicit-employees",
    label: "No-Solicit Of Employees",
    queries: [
      /no-?solicit(?:ation)? .{0,40}(?:employee|personnel|contractor)/i,
      /solicit(?:ation)? .{0,40}(?:employee|personnel|contractor)/i,
      /not .{0,40}(?:hire|solicit) .{0,40}(?:employee|personnel)/i,
    ],
    strong: [
      /\b(?:shall not|will not|may not|agrees? not to)\b.{0,100}\b(?:solicit|recruit|hire|induce|employ)\b.{0,80}\b(?:employees?|personnel|contractors?|consultants?)\b/i,
      /\b(?:solicit|recruit|hire|induce)\b.{0,80}\b(?:employees?|personnel|contractors?|consultants?)\b.{0,80}\b(?:of|from)\s+(?:the\s+)?(?:other party|company|buyer|seller|employer)\b/i,
      /\bsolicit(?:ation)?\b.{0,100}\bfor employment\b.{0,80}\b(?:employees?|personnel|contractors?)\b/i,
      /\bnon-?solicit(?:ation)?\b.{0,80}\b(?:employees?|personnel|contractors?|consultants?)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "non-disparagement",
    label: "Non-Disparagement",
    queries: [/non-?disparag/i, /not .{0,30}disparag/i, /disparag/i, /defam/i],
    strong: [
      /\bdisparag(?:e|es|ed|ement|ing)\b/i,
      /\bdefam(?:e|es|ed|atory|ation)\b/i,
      /\bnegative (?:comments?|statements?)\b/i,
      /\b(?:derogatory|disparaging) (?:comments?|statements?|remarks?)\b/i,
      /\bimpugn\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "termination-for-convenience",
    label: "Termination For Convenience",
    queries: [
      /terminat(?:e|ion) for convenience/i,
      /terminate .{0,30}without cause/i,
      /terminate .{0,30}(?:at any time|for any reason)/i,
      /cancellation .{0,30}(?:without cause|at any time)/i,
      /\btermination\b/i,
      /\bcancellation\b/i,
      /terminate/i,
      /cancel/i,
    ],
    strong: [
      /\b(?:may|shall|will|is entitled to|has the right to)\b.{0,60}\b(?:terminate|cancel)\b.{0,100}(?:without cause|for convenience|for any reason|at any time)\b/i,
      /\b(?:without cause|for convenience|for any reason|at any time)\b.{0,100}\b(?:may|shall|will|is entitled to|has the right to)\b.{0,40}\b(?:terminate|cancel)\b/i,
      /\bterminat(?:e|ion) for convenience\b/i,
      /\b(?:may|shall|will)\b.{0,60}\b(?:terminate|cancel)\b.{0,100}\d+\s*days?'? (?:prior )?(?:written )?notice\b/i,
    ],
    weak: [
      /\b(?:either party|a party|any party) may (?:terminate|cancel) (?:this |the )?(?:agreement|arrangement|contract)\b/i,
    ],
    exclude: [/\b(?:material )?breach\b|\bdefault\b|\binsolven|\bbankrupt/i],
    unless: [
      /\bwithout cause\b|\bfor convenience\b/i,
      /\bat any time after\b|\bat any time (?:by|upon) giving\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "rofr",
    label: "Rofr/Rofo/Rofn",
    queries: [
      /right of first (?:refusal|offer|negotiation)/i,
      /\bROFR\b|\bROFO\b|\bROFN\b/,
      /first right of (?:refusal|offer|negotiation)/i,
    ],
    strong: [
      /\bright of first (?:refusal|offer|negotiation)\b/i,
      /\bROFR\b|\bROFO\b|\bROFN\b/i,
      /\bfirst right of (?:refusal|offer|negotiation)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "change-of-control",
    label: "Change Of Control",
    queries: [
      /change (?:of|in) control/i,
      /merger .{0,40}consent/i,
      /sale of .{0,40}substantially all/i,
      /assignment by operation of law/i,
    ],
    strong: [
      /\bchange (?:of|in) control\b/i,
      /\bassignment by operation of law\b/i,
      /\b(?:reorganization|merger|consolidation|sale of (?:all or )?substantially all)\b.{0,180}\b(?:attempt to assign|consent|notice|terminate|change of control)\b/i,
    ],
    require: [
      /\b(?:consent|terminate|notice|assignment|assign|transfer|merger|control)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "anti-assignment",
    label: "Anti-Assignment",
    queries: [
      /anti-?assignment/i,
      /assignment restrictions?/i,
      /\bassignment\b/i,
      /assign(?:ment)? .{0,40}(?:consent|prohibit|restrict)/i,
      /transfer .{0,40}(?:consent|prohibit|restrict|permission)/i,
      /\bnovation\b/i,
    ],
    strong: [
      /\b(?:shall not|may not|will not|neither party (?:shall|may)|no party (?:shall|may)).{0,50}(?:assign(?:ed|ment)?|transfer(?:red)?)\b/i,
      /\b(?:may|shall|will|must) not (?:be )?(?:assigned|transferred)\b/i,
      /\bassign(?:ment)? (?:of )?this (?:agreement|contract).{0,100}(?:consent|prior written|prohibit)/i,
      /\bassign(?:ment)?\b.{0,120}\b(?:requires?|subject to|conditioned (?:up)?on)\b.{0,80}\b(?:prior )?(?:written )?(?:consent|permission|approval)\b/i,
      /\bwithout (?:the )?(?:prior )?written consent.{0,80}(?:assign(?:ed|ment)?|transfer(?:red)?)\b/i,
      /\b(?:prior )?written (?:consent|permission|approval).{0,60}(?:assign(?:ed|ment)?|transfer(?:red)?)\b/i,
      /\b(?:may|shall|will) (?:only )?(?:assign(?:ed|ment)?|transfer(?:red)?).{0,80}(?:with|upon) (?:the )?(?:prior )?(?:written )?(?:consent|permission|approval)\b/i,
    ],
    exclude: [/\bsuccessors and assigns\b|\bassigns hereunder\b/i],
    maxResults: 2,
  },
  {
    id: "revenue-profit-sharing",
    label: "Revenue/Profit Sharing",
    queries: [
      /revenue sharing/i,
      /profit sharing/i,
      /share .{0,30}(?:revenue|profit|proceeds)/i,
      /royalt(?:y|ies) .{0,30}(?:share|split|percentage)/i,
    ],
    strong: [
      /\b(?:share|split|percentage|percent).{0,80}(?:revenue|profits?|proceeds)\b/i,
      /\b(?:revenue|profit|proceeds).{0,80}(?:share|split|percentage|percent)\b/i,
      /\broyalt(?:y|ies).{0,60}(?:share|split|percentage|percent)\b/i,
      /\bnet (?:revenue|profit) (?:share|split)\b/i,
      /\b(?:donation|royalt(?:y|ies)|commission|fee)\s+of\s+\$?\d[\d,.]*\s*(?:per|for each)\s+(?:unit|copy|product|sale)\b/i,
      /\b(?:donate|pay|remit|share|allocate|split)\b.{0,80}\b\d+(?:\.\d+)?%\b.{0,80}\b(?:proceeds|revenue|sales|profits?)\b/i,
      /\b\d+(?:\.\d+)?%\s+of\b.{0,80}\b(?:proceeds|revenue|sales|profits?)\b/i,
      /\bplus\b.{0,60}\bof\b.{0,40}\b(?:sales|revenue|proceeds|profits?)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "price-restrictions",
    label: "Price Restrictions",
    queries: [
      /price restriction/i,
      /price (?:increase|reduction|change)/i,
      /restrict(?:ion)? .{0,30}(?:raise|reduce|increase|decrease).{0,20}price/i,
      /change .{0,20}prices?/i,
    ],
    strong: [
      /\b(?:shall not|may not|will not|agrees? not to).{0,80}(?:increase|raise|reduce|decrease|change|discount).{0,50}(?:price|prices|fee|fees|rate|rates)\b/i,
      /\b(?:price|prices|fee|fees|rate|rates).{0,80}(?:shall not|may not).{0,50}(?:increase|raise|reduce|decrease|change)\b/i,
      /\b(?:increase|reduction|change) (?:in|of) (?:price|prices|fees?|rates?).{0,80}(?:consent|approval|notice)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "minimum-commitment",
    label: "Minimum Commitment",
    queries: [
      /minimum (?:commitment|purchase|order|amount|quantity|volume)/i,
      /minimum order size/i,
      /must (?:buy|purchase|order) .{0,30}(?:at least|minimum)/i,
    ],
    strong: [
      /\bminimum (?:purchase|order|commitment|quantity|volume|number of (?:units|products|services))\b/i,
      /\b(?:shall|will|must) (?:purchase|buy|order) (?:at least|a minimum of|no less than)\b/i,
      /\bcommit(?:s|ted)? to (?:purchase|buy|order) .{0,60}(?:at least|\d)/i,
      /\bminimum (?:of )?\d[\d,.]*\s*(?:units?|products?|services?|copies?|shares?)\b/i,
      /\b(?:pay|pays|paid|shall pay|will pay)\b.{0,80}\b(?:a )?minimum (?:of|amount|payment|fee|sum)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "volume-restriction",
    label: "Volume Restriction",
    queries: [
      /volume restriction/i,
      /exceed(?:s|ing)? .{0,40}(?:volume|threshold|limit)/i,
      /usage (?:limit|threshold|exceeds)/i,
      /overage/i,
    ],
    strong: [
      /\b(?:usage|volume|number of (?:units|users|transactions)|purchases?).{0,80}(?:exceed|exceeds|exceeding|in excess of).{0,100}(?:fee|consent|approval|additional|pay)\b/i,
      /\b(?:exceed|exceeding|in excess of).{0,60}(?:threshold|limit|volume).{0,100}(?:fee|consent|approval|additional|pay)\b/i,
      /\boverage (?:fee|charge|rate)\b/i,
      /\bno (?:appearance|session|use|order|purchase|delivery)\b.{0,80}\b(?:exceed|more than)\b.{0,40}\b(?:\d+|one|two|three|four|five)\b.{0,20}\b(?:hours?|days?|items?|units?|copies?)\b/i,
      /\b(?:shall|will|may) not (?:exceed|be more than)\b.{0,40}\b(?:two|three|\d+)\b.{0,12}\b(?:hours?|days?|items?|units?)\b/i,
      /\b(?:sign|provide|deliver|supply|purchase|order)\b.{0,40}\b\d[\d,]*\s+(?:items?|units?|copies?|products?|services?)\s+per\s+(?:year|month|quarter|week)\b/i,
      /\b(?:maximum|up to|no more than|not more than)\b.{0,40}\b(?:\d+|one|two|three)\b.{0,12}\b(?:hours?|days?|items?|units?|copies?|appearances?)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "ip-ownership-assignment",
    label: "Ip Ownership Assignment",
    queries: [
      /ip ownership/i,
      /intellectual property .{0,30}ownership/i,
      /ownership .{0,30}intellectual property/i,
      /work (?:made )?for hire/i,
      /assignment .{0,30}(?:intellectual property|inventions?)/i,
    ],
    strong: [
      /\b(?:inventions?|developments?|work product|intellectual property|improvements?).{0,120}(?:shall|will|does) (?:be|become|vest|remain).{0,50}(?:property|owned|ownership)\b/i,
      /\b(?:assign|assigns|assigned|transfer).{0,80}(?:intellectual property|inventions?|patents?|work product|developments?)\b/i,
      /\bwork (?:made )?for hire\b/i,
      /\b(?:all )?right, title and interest .{0,80}(?:shall )?(?:vest|assign|transfer)\b/i,
    ],
    require: [
      /\b(?:intellectual property|inventions?|patents?|copyrights?|trademarks?|work product|work made for hire|developments?|improvements?)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "joint-ip-ownership",
    label: "Joint Ip Ownership",
    queries: [
      /joint ip ownership/i,
      /joint(?:ly)? .{0,20}(?:own|ownership)/i,
      /co-?own(?:ership)?/i,
      /shared ownership .{0,30}(?:intellectual property|inventions?)/i,
    ],
    strong: [
      /\b(?:joint(?:ly)?|co-?own|shared) (?:ownership|own|rights?).{0,80}(?:intellectual property|inventions?|developments?|patents?|work product)\b/i,
      /\b(?:intellectual property|inventions?|developments?|patents?).{0,80}(?:joint(?:ly)? (?:own|ownership)|co-?own)\b/i,
    ],
    require: [
      /\b(?:intellectual property|invention|patent|work product|development)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "license-grant",
    label: "License Grant",
    queries: [
      /license grant/i,
      /grant .{0,30}licen[cs]e/i,
      /\blicen[cs]e\b/i,
      /licensed rights/i,
    ],
    strong: [
      /\b(?:hereby )?(?:grants?|granted|confers?) (?:to .{0,50})?(?:a )?(?:non-?exclusive|exclusive|royalty-free|perpetual|irrevocable|limited|worldwide|non-?transferable)?\s*licen[cs]e\b/i,
      /\blicen[cs]e (?:is )?(?:hereby )?granted\b/i,
      /\bgrants? .{0,60}(?:rights?|licen[cs]e|permission) to (?:use|reproduce|distribute|sell|market|display|publish|sublicense)\b/i,
      /\bsubject to the terms .{0,60}(?:grants?|licen[cs]e)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "non-transferable-license",
    label: "Non-Transferable License",
    queries: [
      /non-?transferable licen[cs]e/i,
      /licen[cs]e .{0,30}(?:transfer|assign)/i,
      /transfer .{0,30}licen[cs]e/i,
    ],
    strong: [
      /\blicen[cs]e.{0,120}(?:non-?transferable|may not be (?:assigned|transferred|sublicensed)|shall not be (?:assigned|transferred)|not transferable)\b/i,
      /\bnon-?transferable.{0,40}licen[cs]e\b/i,
      /\bnon-?sublicensable\b/i,
    ],
    require: [/\blicen[cs]e\b/i],
    maxResults: 2,
  },
  {
    id: "affiliate-license-licensor",
    label: "Affiliate License-Licensor",
    queries: [
      /affiliate license.{0,20}licensor/i,
      /licensor .{0,30}affiliate/i,
      /affiliate .{0,30}licensor/i,
    ],
    strong: [
      /\baffiliates? of (?:the )?licensor\b/i,
      /\blicensor(?:'s|s')? affiliates?\b/i,
    ],
    require: [/\b(?:licen[cs]e|grant|intellectual property|rights?)\b/i],
    maxResults: 2,
  },
  {
    id: "affiliate-license-licensee",
    label: "Affiliate License-Licensee",
    queries: [
      /affiliate license.{0,20}licensee/i,
      /licensee .{0,30}affiliate/i,
      /affiliate .{0,30}licensee/i,
    ],
    strong: [
      /\baffiliates? of (?:the )?licensee\b/i,
      /\blicensee(?:'s|s')? affiliates?\b/i,
      /\blicensee and its affiliates?\b/i,
    ],
    require: [/\b(?:licen[cs]e|grant|intellectual property|rights?)\b/i],
    maxResults: 2,
  },
  {
    id: "unlimited-license",
    label: "Unlimited/All-You-Can-Eat-License",
    queries: [
      /unlimited (?:use|usage|licen[cs]e)/i,
      /all[- ]you[- ]can[- ]eat/i,
      /enterprise licen[cs]e/i,
    ],
    strong: [
      /\bunlimited (?:use|usage|rights?|licen[cs]e)\b/i,
      /\ball[- ]you[- ]can[- ]eat\b/i,
      /\benterprise (?:licen[cs]e|license)\b/i,
      /\bwithout (?:any )?usage (?:limit|restriction)\b/i,
      /\bno (?:usage )?limit\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "irrevocable-perpetual-license",
    label: "Irrevocable Or Perpetual License",
    queries: [
      /irrevocable .{0,30}licen[cs]e/i,
      /perpetual .{0,30}licen[cs]e/i,
      /licen[cs]e .{0,30}(?:irrevocable|perpetual)/i,
    ],
    strong: [
      /\b(?:irrevocable|perpetual).{0,80}licen[cs]e\b/i,
      /\blicen[cs]e.{0,80}(?:irrevocable|perpetual)\b/i,
    ],
    require: [/\b(?:irrevocable|perpetual)\b/i],
    maxResults: 2,
  },
  {
    id: "source-code-escrow",
    label: "Source Code Escrow",
    queries: [
      /source code escrow/i,
      /escrow .{0,30}source code/i,
      /deposit .{0,30}source code/i,
    ],
    strong: [
      /\bsource code.{0,120}escrow\b/i,
      /\bescrow.{0,120}source code\b/i,
      /\bdeposit .{0,80}source code\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "post-termination-services",
    label: "Post-Termination Services",
    queries: [
      /post-?termination/i,
      /after (?:the )?termination/i,
      /following (?:the )?termination/i,
      /survival .{0,30}termination/i,
      /transition services/i,
      /wind[- ]?down/i,
    ],
    strong: [
      /\b(?:after|following|upon|from) (?:the )?(?:termination|expiration|expiry).{0,180}(?:shall|will|must|agrees? to|obligat)\b/i,
      /\b(?:transition|wind[- ]?down|last[- ]?buy) (?:services?|period|obligations?)\b/i,
      /\b(?:return|deliver|transfer) .{0,80}(?:upon|after) (?:termination|expiration)\b/i,
      /\bsurviv(?:e|al).{0,100}(?:obligation|shall (?:continue|remain|survive))\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "audit-rights",
    label: "Audit Rights",
    queries: [
      /audit rights?/i,
      /right to audit/i,
      /inspection rights?/i,
      /\baudit\b/i,
      /\binspect/i,
    ],
    strong: [
      /\b(?:audit|inspect(?:ion)?).{0,120}(?:books?|records?|premises|facilities|accounts?|compliance)\b/i,
      /\b(?:books?|records?|premises|facilities).{0,120}(?:audit|inspect)\b/i,
      /\bright to (?:audit|inspect)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "uncapped-liability",
    label: "Uncapped Liability",
    queries: [
      /\buncapped liability\b/i,
      /\bunlimited liability\b/i,
      /liability .{0,30}(?:uncapped|unlimited)/i,
      /no (?:cap|limit) on liability/i,
    ],
    strong: [
      /\buncapped liability\b/i,
      /\bunlimited liability\b/i,
      /\bliability (?:shall|will) not be (?:limited|capped)\b/i,
      /\bno (?:cap|limitation) (?:on|of) liability\b/i,
      /\bshall not be subject to any (?:cap|limitation) on liability\b/i,
    ],
    exclude: [/\bincluding without limitation\b/i],
    maxResults: 2,
  },
  {
    id: "cap-on-liability",
    label: "Cap On Liability",
    queries: [
      /liability (?:cap|limit)/i,
      /cap(?:ped)? .{0,20}liability/i,
      /limitation of liability/i,
      /maximum liability/i,
    ],
    strong: [
      /\b(?:liability|damages).{0,100}(?:shall not exceed|is limited to|are limited to|shall be limited to|capped at|not to exceed)\b/i,
      /\b(?:cap|limitation) (?:on|of) liability\b/i,
      /\bmaximum (?:aggregate )?liability\b/i,
      /\baggregate liability.{0,80}(?:shall not exceed|is limited)\b/i,
      /\b(?:limitation|exclusion) of (?:liability|damages)\b/i,
      /\b(?:special|indirect|consequential|incidental|punitive) damages\b/i,
      /\b(?:waive|waives|exclude|excludes|disclaim|disclaims)\b.{0,60}\b(?:damages|liability)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "liquidated-damages",
    label: "Liquidated Damages",
    queries: [
      /liquidated damages/i,
      /termination fee/i,
      /fee .{0,30}(?:early )?termination/i,
    ],
    strong: [
      /\bliquidated damages\b/i,
      /\btermination fee\b/i,
      /\b(?:fee|penalty|amount).{0,60}(?:upon|for) (?:early )?termination\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "warranty-duration",
    label: "Warranty Duration",
    queries: [
      /warranty (?:duration|period|term)/i,
      /duration .{0,30}warranty/i,
      /how long .{0,30}warranty/i,
    ],
    strong: [
      /\bwarrant(?:y|ies).{0,160}(?:\d+\s*(?:days|months|years)|period|expire|survive)\b/i,
      /\b(?:warranty|warranties) period\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "insurance",
    label: "Insurance",
    queries: [/\binsurance\b/i, /insured/i, /insurance (?:coverage|policy)/i],
    strong: [
      /\b(?:maintain|carry|obtain|provide).{0,80}(?:insurance|coverage)\b/i,
      /\binsurance (?:coverage|policy|policies)\b/i,
      /\b(?:general|professional|product|commercial) liability insurance\b/i,
      /\binsured (?:against|under)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "covenant-not-to-sue",
    label: "Covenant Not To Sue",
    queries: [
      /covenant not to sue/i,
      /not to sue/i,
      /waive .{0,30}right to sue/i,
    ],
    strong: [
      /\bcovenant not to sue\b/i,
      /\b(?:shall not|will not) (?:sue|bring|assert|commence).{0,80}(?:claim|action)\b/i,
      /\bwaives? .{0,60}right to sue\b/i,
      /\bnot contest .{0,60}(?:validity|ownership)\b/i,
    ],
    maxResults: 2,
  },
  {
    id: "third-party-beneficiary",
    label: "Third Party Beneficiary",
    queries: [
      /third[- ]party benefic/i,
      /beneficiary .{0,30}third part/i,
      /third part(?:y|ies) .{0,40}benefit/i,
    ],
    strong: [
      /\b(?:is|shall be|are) (?:intended )?(?:a )?third[- ]party beneficiar(?:y|ies)\b/i,
      /\bthird[- ]party beneficiar(?:y|ies) .{0,100}(?:entitled|may enforce|right to enforce)\b/i,
      /\bintended (?:to )?(?:benefit|be for the benefit of) .{0,60}third part/i,
    ],
    exclude: [
      /\bno third[- ]party benefic/i,
      /\bshall not (?:create|confer) .{0,60}third[- ]party benefic/i,
      /\bnothing .{0,80}third[- ]party benefic/i,
      /\bnot intended to .{0,40}(?:create|confer) .{0,40}third[- ]party benefic/i,
    ],
    maxResults: 2,
  },
];

const BY_LABEL = new Map(
  CATEGORIES.map((category) => [category.label.toLowerCase(), category]),
);
const OVERVIEW_INTENT =
  /\b(?:summari[sz]e|summary|overview|briefing|executive summary|key terms|high[- ]level)\b/i;

function detectCategory(query) {
  if (typeof query !== "string") return null;
  const text = query.normalize("NFKC");
  if (!text.trim() || OVERVIEW_INTENT.test(text)) return null;
  if (/\bhighlight the parts\b/i.test(text)) {
    const quoted = text.match(/["“]([^"”]{2,80})["”]/);
    return quoted ? BY_LABEL.get(quoted[1].trim().toLowerCase()) || null : null;
  }
  let best = null,
    bestScore = 0;
  for (const category of CATEGORIES)
    for (const pattern of category.queries || []) {
      const match = pattern.exec(text);
      if (!match) continue;
      const score = (match[0].match(/[\p{L}\p{N}]+/gu) || []).join("").length;
      if (score > bestScore) {
        best = category;
        bestScore = score;
      }
    }
  return best;
}

function labelTokens(category) {
  return [
    ...new Set(
      category.label
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(
          (token) =>
            token.length >= 4 &&
            !["with", "from", "termination", "license", "ownership"].includes(
              token,
            ),
        ),
    ),
  ];
}

function clip(text, anchor, maxChars) {
  if (text.length <= maxChars) return { start: 0, end: text.length };
  let start = Math.max(0, anchor - Math.floor(maxChars / 3));
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

function result(doc, paragraph, start, end, text, score) {
  return {
    documentId: doc.id,
    name: doc.name || "Untitled source",
    paragraph,
    text,
    startOffset: start,
    endOffset: end,
    score: Number(score.toFixed(6)),
    ...(doc.supersededBy ? { isPreviousVersion: true } : {}),
  };
}

function clauseScore(category, text) {
  if (
    category.exclude?.some((pattern) => pattern.test(text)) &&
    !category.unless?.some((pattern) => pattern.test(text))
  )
    return 0;
  if (
    category.require &&
    !category.require.every((pattern) => pattern.test(text))
  )
    return 0;
  let score = 0,
    hits = 0,
    anchor = 0;
  for (const pattern of category.strong || []) {
    const match = pattern.exec(text);
    if (!match) continue;
    hits++;
    if (!anchor) anchor = match.index;
    score += 3;
  }
  if (!hits) {
    let weak = 0;
    for (const pattern of category.weak || []) {
      const match = pattern.exec(text);
      if (!match) continue;
      weak++;
      if (!anchor) anchor = match.index;
      score += 0.8;
    }
    if (!weak) return 0;
  }
  const words = labelTokens(category).filter((token) =>
    text.slice(0, 120).toLowerCase().includes(token),
  );
  if (words.length) score += 1.2;
  return { score, anchor };
}

function collectTitle(category, doc, paragraphs, options) {
  const output = [];
  for (let index = 0; index < Math.min(4, paragraphs.length); index++) {
    for (const segment of segments(paragraphs[index].text)) {
      const text = segment.text.replace(/\s+/g, " ").trim();
      if (text.length < 8 || text.length > 300) continue;
      let score = Math.max(0, 1.5 - index * 0.4);
      if (
        /\b(?:agreement|contract|addendum|amendment|licen[cs]e|terms|endorsement|promotion|cooperation|services?|supply|statement of work)\b/i.test(
          text,
        )
      )
        score += 4;
      if (text === text.toUpperCase() && /[A-Z]{4}/.test(text)) score += 1.5;
      if (score <= 0) continue;
      const range = clip(segment.text, 0, options.maxChars);
      output.push(
        result(
          doc,
          index + 1,
          segment.start + range.start,
          segment.start + range.end,
          segment.text.slice(range.start, range.end),
          score,
        ),
      );
    }
  }
  return output;
}

function collectParties(category, doc, paragraphs, options) {
  const output = [];
  for (let index = 0; index < Math.min(6, paragraphs.length); index++) {
    const whole = paragraphs[index].text;
    const entities = (
      whole.match(new RegExp(category.entity.source, "gi")) || []
    ).length;
    if (!entities) continue;
    const intro = category.intro.test(whole);
    if (!intro && !(index < 4 && entities >= 2)) continue;
    let emitted = 0;
    const entityTest = new RegExp(category.entity.source, "i");
    for (const segment of segments(whole)) {
      if (!entityTest.test(segment.text)) continue;
      let score = (intro ? 5 : 3) + Math.min(entities, 4) * 0.5;
      score += Math.max(0, 1 - index * 0.1);
      output.push(
        result(
          doc,
          index + 1,
          segment.start,
          segment.end,
          segment.text.slice(0, options.maxChars),
          score,
        ),
      );
      if (++emitted >= 2) break;
    }
  }
  return output;
}

function collectDates(category, doc, paragraphs, options) {
  const output = [];
  for (let index = 0; index < paragraphs.length; index++) {
    for (const segment of segments(paragraphs[index].text)) {
      const text = segment.text;
      if (!category.dateContext.some((pattern) => pattern.test(text))) continue;
      const hasDate = DATE.test(text);
      const definitional =
        /\b(?:agreement date|effective date|expiration date|expiry date)\b.{0,40}\b(?:means|shall mean|is defined)/i.test(
          text,
        );
      if (!hasDate && !definitional) continue;
      let score = (hasDate ? 6 : 2) + (definitional ? 1 : 0);
      score += Math.max(0, 1 - index * 0.05);
      const anchor = hasDate ? text.search(DATE) : 0;
      const range = clip(text, anchor, options.maxChars);
      output.push(
        result(
          doc,
          index + 1,
          segment.start + range.start,
          segment.start + range.end,
          text.slice(range.start, range.end),
          score,
        ),
      );
    }
  }
  return output;
}

function collectSignatureDates(category, doc, paragraphs, options) {
  const output = [];
  for (let index = 0; index < paragraphs.length; index++) {
    const text = paragraphs[index].text.trim();
    if (text.length > 80) continue;
    const match = text.match(DATE);
    if (!match || text.search(DATE) > 12) continue;
    const nearby = paragraphs
      .slice(Math.max(0, index - 2), Math.min(paragraphs.length, index + 3))
      .map((paragraph) => paragraph.text)
      .join("\n");
    if (!/(?:\/s\/|IN WITNESS WHEREOF|\bDate\b|\bBy:\s*\/s\/)/i.test(nearby))
      continue;
    const segment = segments(paragraphs[index].text).find((part) =>
      DATE.test(part.text),
    );
    if (!segment) continue;
    output.push(
      result(
        doc,
        index + 1,
        segment.start,
        segment.end,
        segment.text.slice(0, options.maxChars),
        5,
      ),
    );
  }
  return output;
}

function collectClauses(category, doc, paragraphs, options) {
  const output = [];
  for (let index = 0; index < paragraphs.length; index++) {
    for (const segment of segments(paragraphs[index].text)) {
      const found = clauseScore(category, segment.text);
      if (!found) continue;
      const anchor = Math.min(segment.text.length - 1, found.anchor);
      const range = clip(segment.text, anchor, options.maxChars);
      output.push(
        result(
          doc,
          index + 1,
          segment.start + range.start,
          segment.start + range.end,
          segment.text.slice(range.start, range.end),
          found.score,
        ),
      );
    }
  }
  return output;
}

function diversify(candidates, limit, maxPerDocument, maxPerParagraph = 1) {
  candidates.sort((a, b) => b.score - a.score);
  const selected = [],
    documents = new Map(),
    paragraphs = new Map();
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const count = documents.get(candidate.documentId) || 0;
    const paragraph = candidate.documentId + ":" + candidate.paragraph;
    const paragraphCount = paragraphs.get(paragraph) || 0;
    if (count >= maxPerDocument || paragraphCount >= maxPerParagraph) continue;
    selected.push(candidate);
    documents.set(candidate.documentId, count + 1);
    paragraphs.set(paragraph, paragraphCount + 1);
  }
  return selected;
}

function retrieveClause(query, docs, options = {}) {
  const category = detectCategory(query);
  if (!category) return null;
  if (!Array.isArray(docs)) return [];
  const limit = bounded(options.limit, 8, 1, 20),
    maxChars = bounded(options.maxChars, 3000, 128, 4000),
    maxPerDocument = bounded(options.maxPerDocument, 3, 1, 20);
  const settings = { maxChars };
  const candidates = [];
  for (const doc of docs) {
    if (
      !doc ||
      typeof doc.text !== "string" ||
      !doc.id ||
      (!options.includeSuperseded && doc.supersededBy)
    )
      continue;
    const paragraphs = paragraphRanges(doc.text);
    if (category.metadata === "title")
      candidates.push(...collectTitle(category, doc, paragraphs, settings));
    else if (category.metadata === "parties")
      candidates.push(...collectParties(category, doc, paragraphs, settings));
    else if (category.metadata === "date") {
      const found = collectDates(category, doc, paragraphs, settings);
      if (!found.length && category.signature)
        found.push(
          ...collectSignatureDates(category, doc, paragraphs, settings),
        );
      candidates.push(...found);
    } else
      candidates.push(...collectClauses(category, doc, paragraphs, settings));
  }
  const perDocument = Math.max(1, category.maxResults || 2);
  return diversify(
    candidates,
    Math.min(limit, perDocument * Math.max(1, Math.min(docs.length, 3))),
    Math.min(maxPerDocument, perDocument),
    category.maxPerParagraph || (category.metadata === "parties" ? 2 : 1),
  );
}

module.exports = {
  CATEGORIES,
  detectCategory,
  retrieveClause,
  paragraphRanges,
  segments,
};
