// Canonicalizes scraped VA names so a VA who registered under several
// spellings folds onto one t_va row instead of one row per spelling.
//
// Same mechanism as scraper/tag-aliases.js (see that file's header): label
// identity is nameToUUID(name), so 乙倉ゅい / 乙倉ゅい（乙倉由依）/ 乙倉ゅい(乙倉由依) /
// 乙倉ゆい each hash to a different UUID and split the works between them. This
// map redirects every variant to the canonical name at the single VA-resolve
// choke point (resolveVaLabel in queries.js), covering scan-insert,
// scan-update and admin-edit.
//
// The map is hand-maintained in va-aliases.json and loaded once at require
// time; restart the server to pick up edits. Existing split rows are merged by
// database/migrations/20260814000000_merge_va_aliases.js.

import assert from 'assert';
import vaAliasesJson from './va-aliases.json' with { type: 'json' };

/**
 * The JSON file's shape: `variant name -> canonical name`, plus the
 * `_comment` metadata key which is dropped below.
 */
interface AliasFile {
  [name: string]: string;
}

// Typed at the import boundary: the JSON module's inferred object type has
// every key and value as string, so it widens cleanly into the map.
const rawAliases: AliasFile = vaAliasesJson;

let aliases: AliasFile = {};
// Drop the _comment metadata key.
for (const [k, v] of Object.entries(rawAliases)) {
  if (k.startsWith('_')) continue;
  aliases[k] = v;
}

/**
 * Map a scraped VA name to its canonical name. Unmapped names return unchanged.
 * @param {string} name Scraped VA name.
 * @returns {string} Canonical name to store/resolve under.
 */
function canonicalizeVaName(name: string): string;
function canonicalizeVaName(name: null): null;
function canonicalizeVaName(name: string | null): string | null {
  return (name != null && Object.prototype.hasOwnProperty.call(aliases, name))
    ? aliases[name]
    : name;
}

if (process.env.NODE_ENV !== 'production' && import.meta.main) {
  assert.strictEqual(canonicalizeVaName('乙倉ゅい（乙倉由依）'), '乙倉ゅい');
  assert.strictEqual(canonicalizeVaName('乙倉ゅい'), '乙倉ゅい');
  assert.strictEqual(canonicalizeVaName('未登録の声優'), '未登録の声優');
  assert.strictEqual(canonicalizeVaName(null), null);
  console.log('va-aliases self-check OK');
}

export { canonicalizeVaName, aliases as vaAliases };
