# Reproducible contract-extraction evaluation

This framework measures extraction against external annotations, explicit abstention, and source-reference integrity. It does not certify legal advice or establish equality with Legora. Results below were obtained on 25–26 October 2026. The clause engine was tuned only against a document-disjoint development partition; its validation partition was run once after the implementation, tests and build were frozen.

## External dataset and provenance

[CUAD v1](https://www.atticusprojectai.org/cuad/) contains 510 commercial contracts and expert-supervised annotations for 41 clause categories. The Atticus Project publishes it under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution: The Atticus Project; Dan Hendrycks, Collin Burns, Anya Chen and Spencer Ball, [CUAD: An Expert-Annotated NLP Dataset for Legal Contract Review](https://arxiv.org/abs/2103.06268), NeurIPS 2021.

The importer references [official repository commit 67faa0e](https://github.com/The-Atticus-Project/cuad/tree/67faa0e6023b04fcaae6cc09497ab00e5d63a2a2). Its `data.zip` contains `train_separate_questions.json`, `test.json`, and `CUADv1.json`. Use the first two files to retain the official 408/102 contract partition. Download into a private temporary directory and extract those named JSON files; the importer does not download data or invoke a model. The frozen archive is [available from the official repository](https://raw.githubusercontent.com/The-Atticus-Project/cuad/67faa0e6023b04fcaae6cc09497ab00e5d63a2a2/data.zip).

| Artifact | SHA-256 |
|---|---|
| Pinned `data.zip` | `f8161d18bea4e9c05e78fa6dda61c19c846fb8087ea969c172753bc2f45b999a` |
| `train_separate_questions.json` | `7de21d2bb741ac939e2a839ef9640634a5e0f9f40ea2b82c6833baf7db33dab4` |
| `test.json` | `007b6a40b0c65247f881627375c3d2e9b6aeeb5dfa89957494feed0765a1a073` |

The official training partition contains one pair of identical contract contexts under different titles. The importer excludes the duplicate context within that partition and records its title, content hash, partition, and retained document ID. Any exact source-content overlap or title overlap across development and test partitions fails, including documents outside the selected sample. The official test partition remains 102 distinct contracts.

The source text is preserved verbatim. CUAD character offsets are converted from Unicode code points to JavaScript UTF-16 offsets. Selected annotations must match their exact source substrings. Sampling uses a fixed seed and whole documents, so questions from one contract cannot be split between development and test. File and document hashes detect accidental changes. The manifest flags whether input hashes match the pinned official files; locally constructed CUAD-format fixtures are not marked as verified official inputs. Hashes do not establish source authenticity beyond the pinned download procedure.

Downloaded datasets, predictions, traces and reports live under ignored `evaluation/data/` or `evaluation/results/`. Do not commit them accidentally. If distributing a prepared dataset, retain its manifest, attribution, license link, original-source references and the description of transformations. The software's ISC license does not replace the dataset license.

## Prepare a fixed sample

With Node 24.15 or newer and the extracted official files:

```sh
node scripts/import-cuad.js --train /private/cuad/train_separate_questions.json --test /private/cuad/test.json --out evaluation/data/cuad-v1 --test-documents 5 --development-documents 0 --seed counsel-cuad-v1
```

Quote paths containing spaces on Windows. Output directories must be new. Optional `--categories 'Governing Law,Anti-Assignment'` selects named question categories without looking at their answers; declare that selection before running an evaluation. Smaller samples are useful for diagnostics, not broad quality claims.

The prepared suite contains:

- `documents.jsonl`: selected source texts, IDs, hashes and partitions.
- `prompts.jsonl`: source IDs/hashes, questions, categories and partitions, with no answers or answerability labels.
- `labels.jsonl`: private evaluation answers and exact offsets, kept separate from the prediction runner.
- `manifest.json`: provenance, sampling rules, full document partition metadata, duplicate exclusions, and hashes of the other files.

Keep answer labels away from the system producing predictions. The retrieval runner receives only public prompts and source documents. The optional Codex runner sends only selected full source paragraphs and questions through standard input; it runs from an unrelated temporary directory and rejects tool use. Its generated response is scored afterward. These controls reduce accidental label leakage; they cannot prove that a public dataset was absent from a model's original training data.

## Evaluate deterministic retrieval

```sh
node scripts/evaluate-legal.js --suite evaluation/data/cuad-v1 --mode retrieval --split test --out evaluation/data/cuad-v1/retrieval-full-v1.json
```

This baseline passes the original complete question to the existing ranker, takes up to three passages of at most 3,000 characters, and treats those passages as extracted answers. It is deliberately a passage-retrieval baseline, not generated legal analysis. `--query-mode category` is an explicit alternative using the public clause-category name. Report the chosen mode and avoid selecting a better mode after inspecting test answers and calling it fresh held-out validation.

The command writes a report and a matching `.predictions.jsonl` file. It does not call a model API. Evaluation measures behavior; a low-quality score is not a software test failure. Incomplete predictions are different: the report says `incomplete`, missing cases score zero, and the CLI exits with code 2. Invalid or mismatched inputs exit with code 1.

## Evaluate an existing Codex account

```sh
node scripts/evaluate-codex.js --suite evaluation/data/cuad-v1 --out evaluation/data/cuad-codex-v1 --max-documents 1 --max-cases 6
```

This optional command requires `codex login status` to report existing ChatGPT sign-in and consumes that account's normal allowance. It refuses API-key or unknown authentication, removes separate API-key variables from the child process, ignores saved client configuration, uses an ephemeral read-only session, and does not start Ollama or make a separate model API call through Counsel. It sends complete selected source paragraphs, with a declared input-character limit; it refuses oversized payloads rather than silently clipping them. It does not send gold annotations, register MCP servers or modify client settings. The model uses the host's default model; the report records a model identifier only when emitted by the CLI.

The selected subset and its labels are written before inference. Selection is deterministic and independent of labels. The output contains the sealed subset, raw public-data trace, normalized predictions and report. Exact quotes are mapped back to source locations; fabricated or ambiguous locations remain invalid rather than being repaired using annotations. The trace must not contain shell, MCP or web-search actions. For an evaluation with all categories on the first selected contract, set `--max-cases 41`; one contract remains a very small sample.

This is a tool-free full-source extraction test. It is separate from `scripts/smoke-codex.js`, which verifies the application's actual MCP workflow. Neither one proves firm-wide legal accuracy.

## Score exports from other systems

```sh
node scripts/evaluate-legal.js --suite evaluation/data/cuad-v1 --predictions /private/predictions.jsonl --split test --out evaluation/results/system-a.json
```

Each JSONL prediction must contain:

```json
{"id":"case-id-from-prompts","documentId":"source-id-from-prompts","documentSha256":"source-sha256-from-prompts","abstained":false,"answers":[{"start":0,"end":12,"text":"exact source"}],"citations":[{"documentId":"source-id-from-prompts","paragraph":1,"quote":"exact source"}]}
```

`start` and `end` use UTF-16 code units and `end` is exclusive. Citation paragraph numbers follow splitting on blank lines, matching the application. An explicit abstention uses `abstained:true`, `answers:[]`, and normally `citations:[]`. Duplicate case IDs, IDs outside the requested partition, document/hash mismatches, duplicated answer locations and inconsistent abstention flags fail. Missing predictions never become automatic correct abstentions.

To compare a future authorized Legora export or another assistant, use exactly the same sealed suite, full source context, questions, output format, and human-review rubric. Record model/version, run time, configuration, context truncation, repeated runs and failure cases. Blind system names during expert review. No authenticated Legora results have been obtained here.

## Metrics and limits

- **Span exact match:** every annotated location must be returned, with exact boundaries and no extra spans. All-case scores include correct empty answers. Answerable-only scores are reported separately to expose class imbalance.
- **Token F1:** multiset token overlap across all annotated answer text, with Unicode normalization, punctuation/symbol removal and English article removal. Returning one of several required spans receives partial credit. This is this repository's metric, not an official CUAD leaderboard score or semantic correctness measure.
- **Answerability:** whether a system returned any span or explicitly abstained. Precision, recall, correct-abstention rate, false answers on unanswerable cases, and balanced accuracy are reported. A system can correctly predict that some clause exists and still extract the wrong passage. Missing predictions remain visible in denominators.
- **Reference integrity:** exact quoted source/paragraph matches and full citation coverage of extracted answers. A matching quote does not prove the interpretation follows from it.
- **Gold evidence coverage:** fraction of annotated spans fully contained in quoted evidence, plus union character overlap. Overlapping quotations cannot inflate coverage above one.

These metrics do not evaluate current law, source authenticity, jurisdiction coverage, authorities, reasoning, harmful advice or advice completeness. A reviewed legal-advice evaluation still needs lawyers, a task-specific rubric, representative approved cases, multiple jurisdictions and dates, blinded review, disagreement resolution, failure severity and sufficient independent documents for statistical confidence. Once an inspected test sample influences development, reserve new untouched documents for later validation.

## Document-disjoint CUAD split and clause-retrieval results

`scripts/split-legal-suite.js` partitions the existing fixed CUAD sample by whole contract. The current split contains three development contracts (123 questions: 35 answerable, 88 unanswerable) and two validation contracts (82 questions: 22 answerable, 60 unanswerable). No contract or question appears in both partitions. The split is local-only under ignored `evaluation/data/cuad-split-v1/`.

The lexical baseline was measured on both partitions before the clause engine was added. The clause engine then introduced deterministic clause-category anchors, metadata extraction, exact source offsets and explicit abstention ahead of lexical ranking. Only development results were used to change anchors. The validation run used the same frozen code and prompts and was not rerun after inspection.

| Document-disjoint split | Lexical dev | Clause dev | Lexical validation | Clause validation |
|---|---:|---:|---:|---:|
| Answerable-only token F1 | 18.12% | 58.55% | 7.74% | 33.98% |
| Answerable-only strict span exact match | 0.00% | 2.86% | 0.00% | 13.64% |
| Answerability balanced accuracy | 56.23% | 100% | 49.39% | 77.05% |
| Correct abstentions | 16/88 | 88/88 | 2/60 | 57/60 |
| False answers on unanswerable cases | 72/88 | 0/88 | 58/60 | 3/60 |
| Missed answerable cases | 2/35 | 0/35 | 1/22 | 9/22 |
| Annotated spans fully covered | 26/57 | 39/57 | 13/41 | 24/41 |
| Gold character coverage | 55.53% | 56.63% | 69.70% | 47.06% |

The development result is strong but comes from only three contracts and should not be treated as an estimate of general accuracy. The validation result is materially lower: 9 answerable clauses were missed and 3 unanswerable clauses produced evidence. Expiration Date extracted neither of its two answerable validation clauses, Agreement Date scored 4.2% on its answerable case, and the three false positives were Competitive Restriction Exception, Uncapped Liability and Covenant Not To Sue. Even where answerability was correct, strict span boundaries matched only 3 of 22 answerable validation cases. Because this validation partition has now been inspected, it is no longer untouched held-out evidence. Future changes need a new document-disjoint holdout before making a fresh generalization claim.

The lexical baseline covered more annotated characters on validation (69.70% versus 47.06%) because it returned many more passages, including most unanswerable ones. Character coverage alone therefore does not establish better extraction. The clause engine's advantage is concentrated in answerability, not in covering every character of every annotated passage.

The corresponding local reports are `evaluation/results/cuad-split-v1/baseline-*.json`, `clause-v3-development.json` and `clause-v1-validation.json`. They are ignored by Git and must not be presented as a Legora comparison.

## Initial measured results

The frozen five-contract sample contains 205 questions: 57 answerable and 148 unanswerable. With original full questions, the deterministic passage baseline returned evidence for 130 of the 148 unanswerable cases. Its 510 quotations all matched source text, demonstrating why quote integrity cannot stand in for extraction accuracy.

| Five-contract passage baseline | Result |
|---|---:|
| Answerable-only token F1 | 14.12% |
| Strict answerable-only span exact match | 0/57 |
| Annotated spans fully covered by retrieved quotes | 39/98 (39.80%) |
| Correct abstentions | 18/148 (12.16%) |
| Answerability balanced accuracy | 53.45% |
| Exact reference precision | 510/510 (100%) |

A live Codex diagnostic then evaluated all 41 categories on the first fixed-sample contract, including 15 answerable and 26 unanswerable questions. The full-source Codex path and the three-passage baseline were scored on those identical questions:

| One-contract diagnostic | Passage baseline | Full-source Codex |
|---|---:|---:|
| Answerable-only token F1 | 7.43% | 50.56% |
| Strict answerable-only span exact match | 0/15 | 0/15 |
| Correct abstentions | 1/26 | 22/26 |
| False answers on unanswerable cases | 25/26 | 4/26 |
| Missed answerable questions | 1/15 | 3/15 |
| Answerability balanced accuracy | 48.59% | 82.31% |
| Exact reference precision | 115/115 | 31/31 |

Codex's positive spans were partial or differed from required annotation boundaries/sets, so none satisfied the strict all-span criterion. Its aggregate all-case token F1 was 72.16%, including correct abstentions; that is **not 72.16% legal accuracy**. The paths also have different context access: Codex received the complete source, while the baseline returned bounded passages. This diagnostic does not isolate model quality or establish general performance. Model training contamination is unknown, and a single contract provides no credible superiority claim.

The preliminary six-question Codex run happened to contain only unanswerable cases: four correct abstentions and two false answers. It cannot measure positive extraction. The later 41-question run expanded coverage to every category without changing the extraction prompt or tuning retrieval against answers. Preserve both runs when reviewing the experiment history.

Local reports are `evaluation/data/cuad-v1/retrieval-full-scored-v2.json`, `evaluation/data/cuad-codex-contract-v1/report-scored-v2.json`, and `evaluation/data/cuad-codex-contract-v1/retrieval-same-cases-v2.json`. They contain case-level results and matching suite fingerprints. These measurements expose specific weaknesses and provide a repeatable improvement target; they do not close the broader legal-accuracy validation gap.
