import { Schema } from "effect"

export const WorkshopItem = Schema.Struct({
  publishedfileid: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  preview_url: Schema.optional(Schema.String),
  file_url: Schema.optional(Schema.String),
  file_size: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
  creator: Schema.optional(Schema.String),
  creator_appid: Schema.optional(Schema.Number),
  time_created: Schema.optional(Schema.Number),
  time_updated: Schema.optional(Schema.Number),
  tags: Schema.optional(
    Schema.Array(
      Schema.Struct({
        tag: Schema.String,
      })
    )
  ),
})
export type WorkshopItem = typeof WorkshopItem.Type

export const QueryFilesResponse = Schema.Struct({
  response: Schema.Struct({
    total: Schema.Number,
    publishedfiledetails: Schema.optional(Schema.Array(WorkshopItem)),
  }),
})

export const GetPublishedFileDetailsResponse = Schema.Struct({
  response: Schema.Struct({
    publishedfiledetails: Schema.Array(WorkshopItem),
  }),
})
