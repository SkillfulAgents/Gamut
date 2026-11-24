import { z } from 'zod'
import { GUIDE, GUIDE_TOPICS } from '../guide'
import { defineTool, READ_ONLY_ANNOTATIONS } from '../tool-definition'

export const getGuide = defineTool({
  name: 'get_guide',
  title: 'Read the Gamut guide',
  description: `How Gamut works and how to use this server's tools well: agents, sessions, drives, the Team Brain, files, and safety. Without topic, the overview. Topics: ${GUIDE_TOPICS.join(', ')}.`,
  scope: 'read',
  input: z.object({
    topic: z.enum(GUIDE_TOPICS).optional().describe('The part of the guide to read; omit for the overview.'),
  }),
  output: z.object({
    topic: z.enum(GUIDE_TOPICS),
    content: z.string(),
    topics: z.array(z.enum(GUIDE_TOPICS)),
  }),
  annotations: READ_ONLY_ANNOTATIONS,
  async handler({ topic }) {
    const chosen = topic ?? 'overview'
    return { topic: chosen, content: GUIDE[chosen], topics: [...GUIDE_TOPICS] }
  },
})

export const guideTools = [getGuide] as const
