/*
 * Shapes of the work metadata the source-site scrapers produce.
 *
 * These types are the boundary between `scraper/*` and the rest of the backend:
 * `filesystem/scannerModules.ts` hands a scrape to `insertWorkMetadata`, and
 * `routes/metadata.ts` hands one to `updateWorkMetadata` for a single-work
 * refresh. Declaring the shape here (rather than in each scraper) is what lets
 * the DB layer and the scrapers agree on one contract.
 */

/** A label reference: a name, plus the storefront's own id when it has one. */
export interface LabelInput {
  /** Storefront id. Unused for resolution — label identity is the name. */
  id?: string | number;
  name: string;
}

/**
 * The circle block of a scrape.
 *
 * A page with no circle leaves this empty (`{}`), and the insert path then
 * fails on the missing name inside nameToUUID — that is upstream behaviour, so
 * the name stays optional here instead of being asserted.
 */
export interface ScrapedCircle {
  id?: string | number;
  name?: string;
}

/** One sample image, as scraped and as stored in `t_work.sample_images` (JSON). */
export interface SampleImage {
  url: string;
  thumb?: string | null;
  width?: number | null;
  height?: number | null;
  /** File name on disk, or null when the image was never downloaded. */
  file?: string | null;
}

/** One entry of a structured トラックリスト description part. */
export interface DescriptionTrack {
  title: string;
  time: string;
}

/** One block of the scraped 作品内容, stored in `t_work.description_parts` (JSON). */
export interface DescriptionPart {
  /** `text`, `image`, `tracklist`, … — the block's `type_*` class. */
  type: string;
  heading: string | null;
  /** Per-part text copy; only the JSON fallback still sets it. */
  text?: string;
  images: string[];
  tracks: DescriptionTrack[];
}

/** One entry of the per-star rating distribution (`rate_count_detail`). */
export interface RateCountDetail {
  review_point: number;
  count: number;
  ratio?: number;
}

/** Cover image URLs keyed by the size name the DLsite assets use. */
export interface CoverUrls {
  main?: string;
  sam?: string;
  '240x240'?: string;
  '360x360'?: string;
}

/** The counters the dynamic DLsite API and the Fanza detail page yield. */
export interface WorkStats {
  dl_count?: number | string | null;
  price?: number | null;
  review_count?: number | null;
  rate_count?: number | null;
  rate_average_2dp?: number | null;
  rate_count_detail?: RateCountDetail[] | null;
  rank?: unknown;
}

/**
 * The `release` a scrape may carry.
 *
 * The DLsite JSON fallback assigns the result of `RegExp.exec()` here — the
 * match array when it matched — rather than the matched string the HTML path
 * produces. That latent upstream bug is preserved verbatim (no runtime change),
 * so the type has to admit both.
 */
export type ScrapedRelease = string | RegExpExecArray | null;

/** A work as the static scrapers produce it. */
export interface ScrapedWorkMetadata extends WorkStats {
  id: string;
  title: string;
  circle: ScrapedCircle;
  nsfw?: boolean | number | null;
  release?: ScrapedRelease;
  tags: LabelInput[];
  vas: LabelInput[];
  illustrators?: LabelInput[];
  scriptWriters?: LabelInput[];
  authors?: LabelInput[];
  series?: LabelInput | null;
  description?: string | null;
  descriptionParts?: DescriptionPart[] | null;
  sampleImages?: SampleImage[] | null;
  coverUrls?: CoverUrls | null;
}

/**
 * A scrape ready to be written: the scanner adds where the work was found.
 * `insertWorkMetadata` writes both; `updateWorkMetadata` does not read them.
 */
export interface WorkMetadata extends ScrapedWorkMetadata {
  rootFolderName?: string;
  dir?: string;
}

/** The wrapper URL ASMR.one serves a work's cover from. */
export interface AsmrOneCoverUrls {
  mainCoverUrl?: string;
  samCoverUrl?: string;
  thumbnailCoverUrl?: string;
}

/** An ASMR.one workInfo response after the scraper normalized it. */
export type AsmrOneWorkMetadata = ScrapedWorkMetadata & AsmrOneCoverUrls;

/** One genre tag of a DLsite review — picked by the reviewer, not the seller. */
export interface ReviewGenre {
  /** DLsite genre id (string in the review API's object map). */
  id?: string;
  name: string;
}

/** One normalized DLsite user review, as `t_dlsite_review` stores it. */
export interface DlsiteReview {
  /** DLsite's own `member_review_id`. */
  id: string;
  workno?: string;
  reviewerId?: string | number | null;
  reviewerName?: string | null;
  /** 1-5 stars. */
  rate?: number | null;
  title?: string | null;
  text?: string | null;
  spoiler?: boolean | number | null;
  recommend?: boolean | number | null;
  isPurchased?: boolean | number | null;
  goodReview?: number | null;
  badReview?: number | null;
  genres?: ReviewGenre[];
  entryDate?: string | null;
  registDate?: string | null;
}
