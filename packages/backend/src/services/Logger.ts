import { Context, Effect, Layer } from "effect"

export interface LoggerImpl {
  readonly info: (msg: string, meta?: Record<string, unknown>) => Effect.Effect<void>
  readonly warn: (msg: string, meta?: Record<string, unknown>) => Effect.Effect<void>
  readonly error: (msg: string, meta?: Record<string, unknown>) => Effect.Effect<void>
  readonly debug: (msg: string, meta?: Record<string, unknown>) => Effect.Effect<void>
}

export class Logger extends Context.Tag("Logger")<Logger, LoggerImpl>() {}

const format = (level: string, msg: string, meta?: Record<string, unknown>): string => {
  const ts = new Date().toISOString()
  const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ""
  return `${ts} [${level}] ${msg}${metaStr}`
}

export const LoggerLive = Layer.succeed(Logger, {
  info: (msg, meta) => Effect.sync(() => console.log(format("INFO", msg, meta))),
  warn: (msg, meta) => Effect.sync(() => console.warn(format("WARN", msg, meta))),
  error: (msg, meta) => Effect.sync(() => console.error(format("ERROR", msg, meta))),
  debug: (msg, meta) =>
    Effect.sync(() => {
      if (process.env["PWE_DEBUG"]) console.log(format("DEBUG", msg, meta))
    }),
})
