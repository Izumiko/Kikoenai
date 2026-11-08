import strftime from './strftime.ts';

/**
 * One row of a works listing, as database/queries.ts assembles it.
 *
 * The JSON columns are optional because the closed-source upstream schema
 * supplied tagNames/tagIds/vaNames/vaIds instead of tagObj/vaObj, and because
 * every *Obj column is deleted once unpacked. Anything not named here -- the
 * scalar t_work columns -- passes through untouched.
 */
interface WorkListRow {
  nsfw: string | number | boolean | null;
  circleObj?: string;
  rate_count_detail?: string;
  rank?: string | null;
  tagObj?: string;
  tagNames?: string;
  tagIds?: string;
  vaObj?: string;
  vaNames?: string;
  vaIds?: string;
  illustratorObj?: string;
  scriptWriterObj?: string;
  seriesObj?: string;
  state?: string;
  play_updated_at?: string;
  updated_at?: string | Date;
  [key: string]: unknown;
}

/** One label reference, as the *Obj JSON columns carry it. */
interface LabelRef {
  id: unknown;
  name?: unknown;
}

interface NormalizeOptions {
  dateOnly?: boolean;
}

/**
 * The columns a row must carry to be normalized.
 *
 * `id` and `nsfw` are the two every listing row has and every caller relies on;
 * declaring the minimum here, rather than taking `WorkListRow`, is what lets a
 * caller hand in the database layer's assembled row type. An interface never
 * gains the implicit index signature `WorkListRow` requires, so a parameter
 * typed as that would reject the very rows it exists to normalize.
 */
type NormalizeInput = {
  id: string;
  nsfw: WorkListRow['nsfw'];
};

// Normalize API endpoints
const normalize = <T extends NormalizeInput>(works: T[], options: NormalizeOptions = {}): T[] => {
  works.map((row) => {
    // Every column below is addressed by name, and the *Obj columns are deleted
    // once unpacked -- hence WorkListRow, the string-keyed view of the row.
    const record = row as unknown as WorkListRow;
    record.nsfw = Boolean(record.nsfw);
    // Both are always supplied by assembleWorks (and by both upstream schemas).
    record.circle = JSON.parse(record.circleObj!);
    record.rate_count_detail = JSON.parse(record.rate_count_detail!);
    record.rank = record.rank ? JSON.parse(record.rank) : null;

    // Open-source schema: tagObj/vaObj from staticMetadata view
    if (record.tagObj) {
      const parsed: { tags?: LabelRef[] } = JSON.parse(record.tagObj);
      record.tags = parsed.tags || [];
    } else {
      // Closed-source upstream schema: tagNames/tagIds
      const tagNames: string[] = record.tagNames ? JSON.parse(record.tagNames) : [];
      const tagIds: string[] = record.tagIds ? JSON.parse(record.tagIds) : [];
      record.tags = tagNames.map((name, i) => ({
        id: tagIds[i],
        name: name
      }));
    }

    if (record.vaObj) {
      const parsed: { vas?: LabelRef[] } = JSON.parse(record.vaObj);
      record.vas = parsed.vas || [];
    } else {
      const vaNames: string[] = record.vaNames ? JSON.parse(record.vaNames) : [];
      const vaIds: string[] = record.vaIds ? JSON.parse(record.vaIds) : [];
      record.vas = vaNames.map((name, i) => ({
        id: vaIds[i],
        name: name
      }));
    }
    if (record.illustratorObj) {
      const parsed: { illustrators?: LabelRef[] } = JSON.parse(record.illustratorObj);
      record.illustrators = (parsed.illustrators || []).filter(i => i.id !== null);
    } else {
      record.illustrators = [];
    }

    if (record.scriptWriterObj) {
      const parsed: { scriptWriters?: LabelRef[] } = JSON.parse(record.scriptWriterObj);
      record.scriptWriters = (parsed.scriptWriters || []).filter(s => s.id !== null);
    } else {
      record.scriptWriters = [];
    }

    if (record.seriesObj) {
      const parsed: { series?: LabelRef[] } = JSON.parse(record.seriesObj);
      const filtered = (parsed.series || []).filter(s => s.id !== null);
      record.series = filtered.length > 0 ? filtered[0] : null;
    } else {
      record.series = null;
    }

    if (record.hasOwnProperty("state")) {
      // A play-history row always carries both; only the join produces them.
      record.state = JSON.parse(record.state!);
      record.play_updated_at = strftime('%F', record.play_updated_at!);
    }
    delete record.circleObj;
    delete record.tagObj;
    delete record.vaObj;
    delete record.illustratorObj;
    delete record.scriptWriterObj;
    delete record.seriesObj;
    delete record.tagNames;
    delete record.tagIds;
    delete record.vaNames;
    delete record.vaIds;
    if (options.dateOnly && record.updated_at) {
      record.updated_at = strftime('%F', record.updated_at);
    }
  });
  return works;
};

export default normalize;
