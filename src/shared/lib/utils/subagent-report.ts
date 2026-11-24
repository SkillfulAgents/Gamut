import { z } from 'zod'

const resultSchema = z.object({
  status: z.literal('completed'),
  content: z.array(z.unknown()),
  harnessNoteCount: z.number().int().nonnegative().default(0),
  harnessTailCount: z.number().int().nonnegative().default(0),
})
const textBlock = z.object({ type: z.literal('text'), text: z.string() })

/** The SDK stores the report alongside its instructions to the parent model.
 *  Its block counts delimit the author's content, including on older runs with no notes. */
export function subagentReport(result: unknown): string | undefined {
  const parsed = resultSchema.safeParse(result)
  if (!parsed.success) return undefined
  const { content, harnessNoteCount, harnessTailCount } = parsed.data
  const report = content.slice(harnessNoteCount, Math.max(0, content.length - harnessTailCount))
  return report.flatMap(block => {
    const part = textBlock.safeParse(block)
    return part.success ? [part.data.text] : []
  }).join('\n')
}
