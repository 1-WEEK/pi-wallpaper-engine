export const ADULT_TITLE_HINTS = [/ahegao/i]

export const hasAdultTitleHint = (title: string | null | undefined): boolean =>
  !!title && ADULT_TITLE_HINTS.some((pattern) => pattern.test(title))

export const hasAdultMetadata = (
  contentRating: string | null | undefined,
  ratingSex: string | null | undefined
): boolean =>
  contentRating?.toLowerCase() === "mature" ||
  (!!ratingSex && ratingSex.toLowerCase() !== "none")

export const isAdultContent = ({
  title,
  contentRating,
  ratingSex,
  adultHint = false,
}: {
  title?: string | null
  contentRating?: string | null
  ratingSex?: string | null
  adultHint?: boolean | number | null
}): boolean =>
  hasAdultMetadata(contentRating, ratingSex) || !!adultHint || hasAdultTitleHint(title)
