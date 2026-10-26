# Public publication research and watches

Counsel can search the US Federal Register without a provider API key. Open **Legal research**, choose a matter, enter a topic and publication-date range, and select **Search public source**. Only the entered query and dates go to FederalRegister.gov; the workspace does not send your matter documents. This feature makes no model API call.

Results show publication type, date, source-reported effective date when provided, agency, abstract, a publication page and a matching official PDF link when available. A proposed rule, notice or executive document must not be treated as a final rule solely because it appeared in a search. The Federal Register site's legal-status notice describes its search/XML rendition as informational and directs readers to the official edition. Read that edition and assess effective dates, amendments and subsequent treatment before relying on a result.

Editors and owners can **Import official PDF text** into the current matter. The server verifies the document number and the exact expected govinfo.gov PDF path, rejects redirects, bounds download size and time, and parses the PDF in the existing isolated parser. Imported source metadata records the official URL, document number, publication/effective dates, citation, retrieval time and SHA-256 of the downloaded PDF. Original PDF bytes are not retained by this feature. Reimporting identical content returns the existing source; changed content creates an immutable new version and retains earlier citations. Parsing errors or empty scans do not silently import an abstract as full text.

## Publication watches

An editor or owner can create a publication watch with a named query, start date and interval of 15 minutes to one day. Its initial matching publications become a baseline. Later scans create deduplicated in-app alerts for newly discovered matching document numbers. Watches run only while this server runs. Users can scan manually, pause/resume and dismiss alerts. Publication dates are search filters, not verification that a law is currently in force.

There are at most 50 watches per workspace, five API pages or 100 results per scan, 200 recent alerts and 2,000 recent seen identifiers per watch. Initial results exceeding 100 are rejected with a request to narrow the query/date range. Later incomplete scans show an explicit error and keep the earlier search window so the application does not label partial coverage complete. Complete scans retain a two-day overlap, bounded by the original start date, to discover late-arriving publications. Old, backdated publications outside that overlap, source outages, corrections under an existing identifier and results beyond the cap can be missed. This is publication discovery, not a comprehensive regulatory-change or case-law treatment service.

The watch creator must remain an active owner/editor with current matter access. Access is rechecked after network waits. Revocation stops scheduled work; users must create a new authorized watch if its creator loses access. Viewer accounts can read results and alerts for granted matters; guests cannot use internal research APIs. No alert emails, Teams messages or Slack notifications are sent by this feature.

## Verification

Offline tests cover constrained URLs, response bounds, malformed sources, source/version identity, account/matter permissions, source failures, session revocation, duplicate alerts and scheduled scans. On 25 October 2026 a live public-source check retrieved document `2024-04573` from the API, downloaded its matching official PDF (250,891 bytes), and extracted 40,154 characters through the isolated PDF parser. This verifies that source path, not legal interpretation, coverage or current force.

## Primary references

- [Federal Register API documentation](https://www.federalregister.gov/developers/documentation/api/v1): public endpoints require no API key.
- [Federal Register legal status](https://www.federalregister.gov/reader-aids/government-policy/official-editions): verify the informational rendition against the official edition.
- [Verified publication page](https://www.federalregister.gov/documents/2024/03/01/2024-04573/preventing-access-to-americans-bulk-sensitive-personal-data-and-united-states-government-related-data-by).

Broader case law, state law, other jurisdictions, licensed commentary, citator/subsequent-treatment validation and legal conclusions remain separate work.
