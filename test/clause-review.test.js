const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectCategory,
  retrieveClause,
  paragraphRanges,
  segments,
} = require("../clause-review");

function doc(text, id = "contract") {
  return { id, name: "Contract", text };
}
function ask(label, text) {
  return `Highlight the parts (if any) of this contract related to "${label}" that should be reviewed by a lawyer.`;
}
function top(label, text) {
  return retrieveClause(ask(label, text), [doc(text)], {
    limit: 3,
    maxChars: 3000,
  });
}

test("quoted evaluation prompts map to the clause taxonomy without stealing overviews", () => {
  assert.equal(detectCategory(ask("Governing Law")).id, "governing-law");
  assert.equal(detectCategory(ask("Cap On Liability")).id, "cap-on-liability");
  assert.equal(
    detectCategory("Summarize the governing law and liability terms"),
    null,
  );
  assert.equal(detectCategory("What are the documents?"), null);
  assert.equal(detectCategory("law"), null);
});

test("governing law finds the governing-law clause but not incorporation recitals", () => {
  const text =
    "Acme Inc. is a corporation organized under the laws of Delaware.\n\n" +
    "17. Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the State of Connecticut.";
  const results = top("Governing Law", text);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /governed by and construed/);
  assert.equal(results[0].paragraph, 2);
});

test("an absent clause abstains instead of returning a nearby generic sentence", () => {
  const text =
    "The parties shall cooperate in good faith.\n\nNotice must be given in writing.";
  assert.deepEqual(top("Most Favored Nation", text), []);
  assert.deepEqual(top("No-Solicit Of Employees", text), []);
  assert.deepEqual(top("Source Code Escrow", text), []);
});

test("non-compete paraphrases are found without treating ordinary competition as a covenant", () => {
  const text =
    "During the Term, the Distributor will not enter into any agreement that enables a Competing Retailer to be endorsed.\n\n" +
    "The Company competes in the consumer water market.";
  const results = top("Non-Compete", text);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /will not enter into/);
});

test("anti-assignment covers passive past participles", () => {
  const text =
    "9.2 Assignment. This Agreement may not be assigned by either party without the prior written consent of the other party.";
  const results = top("Anti-Assignment", text);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /may not be assigned/);
});

test("revenue sharing recognizes per-unit donations and percentage-of-proceeds wording", () => {
  const text =
    "A donation of $0.05 per Unit sold of Licensed Products is payable quarterly.\n\n" +
    "The chapter will donate 15% of the above described proceeds to the national organization.";
  const results = top("Revenue/Profit Sharing", text);
  assert.equal(results.length, 2);
  assert.match(results[0].text, /per Unit/);
  assert.match(results[1].text, /15% of the above described proceeds/);
});

test("a payment minimum is a minimum commitment", () => {
  const text =
    "3.3.1 For each month during the Term, the Company will pay CNET a minimum of $10,000 in cash.";
  const results = top("Minimum Commitment", text);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /a minimum of/);
});

test("liability caps cover limitations and excluded damages, not capability prose", () => {
  const capped =
    "9.1 LIMITATION OF DAMAGES. NEITHER PARTY WILL BE LIABLE FOR ANY SPECIAL, INDIRECT, CONSEQUENTIAL OR INCIDENTAL DAMAGES ARISING OUT OF THIS AGREEMENT.";
  const capResults = top("Cap On Liability", capped);
  assert.equal(capResults.length, 1);
  assert.match(capResults[0].text, /LIMITATION OF DAMAGES/);

  const generic =
    "Capability planning is complete. The lawyer reviewed the liability section.";
  assert.deepEqual(top("Cap On Liability", generic), []);
});

test("termination for convenience is separated from breach and insolvency termination", () => {
  const convenience =
    "Either party may terminate this Agreement at any time after the first three months by giving 30 days' written notice.";
  const convenienceResults = top("Termination For Convenience", convenience);
  assert.equal(convenienceResults.length, 1);
  assert.match(convenienceResults[0].text, /may terminate/);

  const insolvency =
    "Following an Event of Insolvency, the other Party may at any time thereafter terminate this Agreement.";
  assert.deepEqual(top("Termination For Convenience", insolvency), []);
});

test("employee non-solicitation requires a real solicitation covenant", () => {
  const relationship =
    "18. RELATIONSHIP BETWEEN THE PARTIES. Nothing in this Agreement creates an employer/employee relationship.";
  assert.deepEqual(top("No-Solicit Of Employees", relationship), []);

  const covenant =
    "During the term, the Company shall not solicit or hire any employee of the other party.";
  const results = top("No-Solicit Of Employees", covenant);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /solicit or hire/);
});

test("IP ownership does not treat a license-rights non-assignment as an IP transfer", () => {
  const license =
    "Auriemma will not assign or transfer any of the License Rights described in Paragraph 2.";
  assert.deepEqual(top("Ip Ownership Assignment", license), []);

  const assignment =
    "All inventions and work product developed under this Agreement shall be the sole property of the Company.";
  const results = top("Ip Ownership Assignment", assignment);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /sole property/);
});

test("competitive-restriction exceptions include carve-outs and retained discretion", () => {
  const text =
    "CNET will not enter into more than two agreements with a Competing Retailer; provided that the foregoing will not restrict standard advertisements for any Competing Retailer.";
  const results = top("Competitive Restriction Exception", text);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /provided that/);
});

test("volume restrictions recognize appearance and signing limits", () => {
  const text =
    "(d) Unless otherwise agreed in advance, no appearance shall exceed a total of two (2) hours in duration.";
  const results = top("Volume Restriction", text);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /two \(2\) hours/);
});

test("non-disparagement recognizes third-person verb forms", () => {
  const text =
    "Berkshire may terminate this Agreement if Auriemma publicly disparages Berkshire or its products.";
  const results = top("Non-Disparagement", text);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /disparages/);
});

test("date metadata returns exact source spans with matching offsets", () => {
  const text =
    "This Promotion Agreement is dated as of January 26, 1998 between CNET, Inc. and Cyberian Outpost, Inc.";
  const results = top("Agreement Date", text);
  assert.equal(results.length, 1);
  assert.equal(
    text.slice(results[0].startOffset, results[0].endOffset),
    results[0].text,
  );
  assert.match(results[0].text, /January 26, 1998/);
});

test("signature dates are found when the contract has no dated-as-of recital", () => {
  const text =
    "IN WITNESS WHEREOF, the Parties execute this Agreement intending to be legally bound.\n\n" +
    "/s/ Geno Auriemma\n\n5/17/12 GENO AURIEMMA\n\nDate BERKSHIRE BANK";
  const results = top("Agreement Date", text);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /5\/17\/12/);
});

test("parties returns both sides of an introductory clause", () => {
  const text =
    'This Promotion Agreement is dated as of January 26, 1998 between CNET, Inc. ("CNET") and Cyberian Outpost, Inc. (the "Company").';
  const results = top("Parties", text);
  assert.equal(results.length, 2);
  assert.match(results[0].text, /CNET, Inc\./);
  assert.match(results[1].text, /Cyberian Outpost, Inc\./);
});

test("segmentation retains exact offsets and paragraph anchors", () => {
  const text =
    "Heading\n\nFirst sentence. Second sentence.\n\nThird paragraph.";
  const paragraphs = paragraphRanges(text);
  assert.equal(paragraphs.length, 3);
  for (const [index, paragraph] of paragraphs.entries()) {
    for (const segment of segments(paragraph.text)) {
      assert.equal(
        text.slice(
          paragraph.start + segment.start,
          paragraph.start + segment.end,
        ),
        segment.text,
      );
      assert.equal(segment.text, segment.text.trim());
      assert.ok(segment.start >= 0 && segment.end <= paragraph.text.length);
    }
    assert.equal(
      text.slice(paragraph.start, paragraph.end),
      paragraph.text,
      `paragraph ${index + 1} offsets`,
    );
  }
});
