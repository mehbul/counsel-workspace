const { z } = require("zod");
const text = (n) => z.string().trim().min(1).max(n);
const cite = z
  .object({
    documentId: z.string().uuid(),
    paragraph: z.number().int().min(1),
    quote: z.string().min(1).max(6000),
  })
  .strict();
const page = {
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
const schemas = {
  session: z.object({}).strict(),
  list_matters: z.object(page).strict(),
  list_documents: z
    .object({
      matterId: z.string().uuid(),
      includePrevious: z.boolean().default(false),
      ...page,
    })
    .strict(),
  read_document: z
    .object({
      matterId: z.string().uuid(),
      documentId: z.string().uuid(),
      paragraphOffset: z.number().int().min(0).max(2000000).default(0),
      startParagraph: z.number().int().min(1).max(100000).default(1),
      limit: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  search: z
    .object({
      matterId: z.string().uuid(),
      query: text(2000),
      documentIds: z.array(z.string().uuid()).max(100).optional(),
    })
    .strict(),
  compare_documents: z
    .object({
      matterId: z.string().uuid(),
      documentIds: z.array(z.string().uuid()).min(2).max(4),
      questions: z.array(text(500)).min(1).max(6),
    })
    .strict(),
  check_evidence: z
    .object({
      matterId: z.string().uuid(),
      text: z.string().max(200000),
      citations: z.array(cite).max(100),
    })
    .strict(),
  list_drafts: z.object({ matterId: z.string().uuid(), ...page }).strict(),
  read_draft: z
    .object({
      matterId: z.string().uuid(),
      draftId: z.string().uuid(),
      offset: z.number().int().min(0).max(1000000).default(0),
      limit: z.number().int().min(1).max(24000).default(12000),
    })
    .strict(),
  import_text: z
    .object({
      matterId: z.string().uuid(),
      requestId: z.string().uuid(),
      name: text(200),
      text: text(200000),
    })
    .strict(),
  create_draft: z
    .object({
      matterId: z.string().uuid(),
      requestId: z.string().uuid(),
      title: text(200),
      content: text(200000),
      citations: z.array(cite).max(100).default([]),
    })
    .strict(),
  create_review: z
    .object({
      matterId: z.string().uuid(),
      requestId: z.string().uuid(),
      name: text(200),
      columns: z.array(text(500)).min(1).max(12),
      documentIds: z.array(z.string().uuid()).min(1).max(100),
    })
    .strict(),
  save_review: z
    .object({
      matterId: z.string().uuid(),
      requestId: z.string().uuid(),
      name: text(200),
      columns: z.array(text(500)).min(1).max(12),
      rows: z
        .array(
          z
            .object({
              documentId: z.string().uuid(),
              cells: z
                .array(
                  z
                    .object({
                      value: z.string().max(6000),
                      citations: z.array(cite).max(5).default([]),
                    })
                    .strict(),
                )
                .min(1)
                .max(12),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  read_review: z
    .object({
      matterId: z.string().uuid(),
      reviewId: z.string().uuid(),
      ...page,
    })
    .strict(),
  create_task: z
    .object({
      matterId: z.string().uuid(),
      requestId: z.string().uuid(),
      title: text(500),
    })
    .strict(),
};

module.exports = { schemas };
