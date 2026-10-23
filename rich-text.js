const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  LevelFormat,
} = require("docx");
const { z } = require("zod");
const attributes = z
  .object({
    bold: z.literal(true).optional(),
    italic: z.literal(true).optional(),
    underline: z.literal(true).optional(),
    strike: z.literal(true).optional(),
    header: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    list: z.enum(["ordered", "bullet"]).optional(),
    blockquote: z.literal(true).optional(),
    align: z.enum(["left", "center", "right", "justify"]).optional(),
    indent: z.number().int().min(0).max(8).optional(),
  })
  .strict();
const schema = z
  .array(
    z
      .object({
        insert: z.string().max(1000000),
        attributes: attributes.optional(),
      })
      .strict(),
  )
  .max(100000);
function validateDelta(delta) {
  return schema.parse(delta);
}
function paragraphs(draft) {
  const delta = draft.richContent
    ? validateDelta(draft.richContent)
    : [{ insert: draft.content }];
  const output = [];
  let runs = [];
  const flush = (a = {}) => {
    output.push(
      new Paragraph({
        children: runs,
        heading: a.header
          ? [
              HeadingLevel.HEADING_1,
              HeadingLevel.HEADING_2,
              HeadingLevel.HEADING_3,
            ][a.header - 1]
          : undefined,
        alignment: {
          center: AlignmentType.CENTER,
          right: AlignmentType.RIGHT,
          justify: AlignmentType.JUSTIFIED,
        }[a.align],
        bullet: a.list === "bullet" ? { level: a.indent || 0 } : undefined,
        numbering:
          a.list === "ordered"
            ? { reference: "counsel-list", level: a.indent || 0 }
            : undefined,
        indent: a.blockquote ? { left: 720 } : undefined,
      }),
    );
    runs = [];
  };
  for (const op of delta) {
    const pieces = op.insert.split("\n"),
      a = op.attributes || {};
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i])
        runs.push(
          new TextRun({
            text: pieces[i],
            bold: a.bold,
            italics: a.italic,
            underline: a.underline ? {} : undefined,
            strike: a.strike,
          }),
        );
      if (i < pieces.length - 1) flush(a);
    }
  }
  if (runs.length || !output.length) flush();
  return output;
}
function buildDocx(draft) {
  return Packer.toBuffer(
    new Document({
      numbering: {
        config: [
          {
            reference: "counsel-list",
            levels: Array.from({ length: 9 }, (_, level) => ({
              level,
              format: LevelFormat.DECIMAL,
              text: `%${level + 1}.`,
              alignment: AlignmentType.START,
              style: {
                paragraph: {
                  indent: { left: 720 * (level + 1), hanging: 360 },
                },
              },
            })),
          },
        ],
      },
      sections: [
        {
          children: [
            new Paragraph({ text: draft.title, heading: HeadingLevel.TITLE }),
            ...paragraphs(draft),
          ],
        },
      ],
    }),
  );
}
module.exports = { validateDelta, buildDocx };
