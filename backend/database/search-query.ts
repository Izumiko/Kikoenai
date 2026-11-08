/**
 * E-Hentai style advanced search query parsing.
 *
 * Grammar — whitespace separates terms, every term must match (AND):
 *
 *   term      := ['-'] [ namespace ':' ] value
 *   value     := '"' anything '"' | bare
 *   bare      := run of non-whitespace; each '_' stands for a space
 *
 * A trailing '$' (inside or right after the quotes) anchors the value: it has
 * to match the whole name instead of any substring. A leading '-' negates the
 * term. A term without a namespace keeps the old behaviour — it is matched
 * against every metadata field at once.
 *
 * An unknown namespace is not special: `foo:bar` searches for the literal text
 * "foo:bar", so titles containing a colon still work.
 *
 *   va:"space separated name$"   circle:underscore_name   -tag:NTR
 *
 * This module is the only definition of the grammar. The frontend renders the
 * same terms the backend matches on, so it imports this file directly rather
 * than mirroring it (`FilterTerms.vue`, `src/utils.js`). Keep it free of
 * `require`s and of anything Node-only, or the browser bundle breaks.
 */

/** Canonical field a term can carry; `null` means "every metadata field". */
export type SearchField =
  | 'circle'
  | 'tag'
  | 'va'
  | 'illustrator'
  | 'script_writer'
  | 'series'
  | 'author'
  | 'title'
  | 'id';

/** A term as the parser produces it. */
export interface SearchTerm {
  /** null for a free-text term; terms are ANDed by the caller. */
  field: SearchField | null;
  /** The value with underscores already turned into spaces. */
  value: string;
  /** The value before underscores become spaces — work codes live here. */
  raw: string;
  /** Match the whole name instead of a substring (`$`). */
  exact: boolean;
  /** Matched negatively (`-field:value`). */
  negate: boolean;
}

/** A term the caller wants rendered; only `value` is required. */
export interface SearchTermInput {
  field: SearchField | null;
  value: string;
  exact?: boolean;
  negate?: boolean;
}

/** How one canonical field maps onto its name table and work link table. */
export interface RelationField {
  nameTable: string;
  relTable: string;
  key: string;
}

/** Accepted namespaces (lower-cased) → canonical field name. */
export const FIELD_ALIASES: Record<string, SearchField> = {
  circle: 'circle', group: 'circle',
  tag: 'tag', tags: 'tag',
  va: 'va', cv: 'va', voice: 'va',
  illustrator: 'illustrator', illust: 'illustrator',
  script_writer: 'script_writer', scriptwriter: 'script_writer',
  scenario: 'script_writer', script: 'script_writer',
  series: 'series',
  author: 'author',
  title: 'title',
  id: 'id',
};

/** Canonical field → the tables that link a work to that name. */
export const RELATION_FIELDS: Partial<Record<SearchField, RelationField>> = {
  tag: { nameTable: 't_tag', relTable: 'r_tag_work', key: 'tag_id' },
  va: { nameTable: 't_va', relTable: 'r_va_work', key: 'va_id' },
  illustrator: { nameTable: 't_illustrator', relTable: 'r_illustrator_work', key: 'illustrator_id' },
  script_writer: { nameTable: 't_script_writer', relTable: 'r_script_writer_work', key: 'script_writer_id' },
  series: { nameTable: 't_series', relTable: 'r_series_work', key: 'series_id' },
  author: { nameTable: 't_author', relTable: 'r_author_work', key: 'author_id' },
};

const isSpace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);

/**
 * Split a raw search box string into filter terms.
 * @param filter
 * @returns terms, ANDed by the caller.
 */
const parseSearchQuery = (filter: unknown): SearchTerm[] => {
  const input = String(filter || '');
  const terms: SearchTerm[] = [];
  let i = 0;

  while (i < input.length) {
    if (isSpace(input[i])) { i += 1; continue; }

    let negate = false;
    if (input[i] === '-' && !isSpace(input[i + 1])) {
      negate = true;
      i += 1;
    }

    let field: SearchField | null = null;
    const prefix = /^([A-Za-z_]+):/.exec(input.slice(i));
    if (prefix && FIELD_ALIASES[prefix[1].toLowerCase()]) {
      field = FIELD_ALIASES[prefix[1].toLowerCase()];
      i += prefix[0].length;
    }

    let value: string;
    const quoted = input[i] === '"';
    if (quoted) {
      const end = input.indexOf('"', i + 1);
      value = (end === -1) ? input.slice(i + 1) : input.slice(i + 1, end);
      i = (end === -1) ? input.length : end + 1;
    } else {
      let end = i;
      while (end < input.length && !isSpace(input[end])) end += 1;
      value = input.slice(i, end);
      i = end;
    }

    // '$' anchors the match, whether it sits inside or after the quotes
    let exact = false;
    while (input[i] === '$') { exact = true; i += 1; }
    if (value.endsWith('$')) {
      exact = true;
      value = value.slice(0, -1);
    }

    const raw = value.trim();
    if (!quoted) value = value.replace(/_/g, ' ');
    value = value.trim();
    if (value) terms.push({ field, value, raw, exact, negate });
  }

  return terms;
};

/**
 * Render one term back into query syntax — the inverse of parseSearchQuery,
 * used by the frontend to build a filter from a clicked label and to drop a
 * term from an existing one.
 *
 * The value is always quoted, so it survives verbatim: the bare form rewrites
 * '_' as a space, which would silently retarget any name containing one.
 */
const formatSearchTerm = ({ field, value, exact = false, negate = false }: SearchTermInput): string =>
  `${negate ? '-' : ''}${field ? `${field}:` : ''}"${value}${exact ? '$' : ''}"`;

/** Join terms back into a single search box string. */
const formatSearchQuery = (terms: readonly SearchTermInput[]): string => terms.map(formatSearchTerm).join(' ');

export { parseSearchQuery, formatSearchTerm, formatSearchQuery };
