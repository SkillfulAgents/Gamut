import { z } from 'zod'

// GET /v1/web-search. Only the ranked sources are read; `answer` and `rows`, which the API adds
// for some questions, are not part of the normalized hit list.
export const SpecStreamSearchResponseSchema = z.object({
  data: z.object({
    sources: z.array(z.object({
      url: z.string(),
      title: z.string().nullish(),
      snippet: z.string().nullish(),
      published: z.string().nullish(),
    })).default([]),
  }),
})

// POST /v1/extract. One result per URL sent, in order.
export const SpecStreamExtractResponseSchema = z.object({
  data: z.object({
    results: z.array(z.object({
      url: z.string(),
      status: z.string(),
      title: z.string().nullish(),
      text: z.string().nullish(),
      published: z.string().nullish(),
      read_from: z.string().nullish(),
    })),
  }),
})
