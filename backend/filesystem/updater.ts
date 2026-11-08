// @ts-nocheck

import { parseArgs } from 'util';

import pjson from '../package.json' with { type: 'json' };
import { performUpdate } from './scannerModules.ts';

// One entry per flag: the long name used by the code below, the alias this
// script has always accepted, and the help text. Node's parseArgs has no alias
// support, so the alias is registered as its own boolean option.
const optionDefinitions = [
  { name: 'refreshAll', alias: 'all', description: 'Refresh both dynamic and static metadata' },
  { name: 'includeNSFW', alias: 'nsfw', description: 'Refresh dynamic metadata and nsfw field' },
  { name: 'includeTags', alias: 'tags', description: 'Refresh dynamic metadata and tags' },
  { name: 'includeVA', alias: 'vas', description: 'Refresh dynamic metadata and voice actors' },
  { name: 'includeIllustrator', alias: 'illust', description: 'Refresh dynamic metadata and illustrators' },
  { name: 'includeScriptWriter', alias: 'scenario', description: 'Refresh dynamic metadata and script writers' },
  { name: 'includeSeries', alias: 'series', description: 'Refresh dynamic metadata and series' },
  { name: 'includeAuthor', alias: 'author', description: 'Refresh dynamic metadata and authors (作者)' },
  { name: 'includeDescription', alias: 'description', description: 'Refresh dynamic metadata and the work description (no image download)' },
  { name: 'includeImages', alias: 'images', description: 'Re-download the sample and description images (one request per image)' },
  { name: 'includeReviews', alias: 'reviews', description: 'Re-scrape every DLsite user review (paginated, one request per 50)' },
];

const optionConfig = {
  help: { type: 'boolean' },
  version: { type: 'boolean' },
};
for (const { name, alias } of optionDefinitions) {
  optionConfig[name] = { type: 'boolean' };
  optionConfig[alias] = { type: 'boolean' };
}

const USAGE = [
  'Usage: updater [options]',
  '',
  'Options:',
  '  --help     Show help',
  '  --version  Show version',
  ...optionDefinitions.map(({ name, alias, description }) => `  --${name}, --${alias}  ${description}`),
].join('\n');

let values;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: optionConfig,
    strict: true,
  }));
} catch (err) {
  console.error(`updater: ${err.message}`);
  console.error(USAGE);
  process.exit(1);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (values.version) {
  console.log(pjson.version);
  process.exit(0);
}

const flag = (name) => values[name] === true;

const updateOptions = {};

if (flag('refreshAll') || flag('all')) {
  updateOptions.refreshAll = true;
} else if (flag('includeNSFW') || flag('nsfw')) {
  updateOptions.includeNSFW = true;
} else if (flag('includeTags') || flag('tags')) {
  updateOptions.includeTags = true;
} else if (flag('includeVA') || flag('vas')) {
  updateOptions.includeVA = true;
} else if (flag('includeIllustrator') || flag('illust')) {
  updateOptions.includeIllustrator = true;
} else if (flag('includeScriptWriter') || flag('scenario')) {
  updateOptions.includeScriptWriter = true;
} else if (flag('includeSeries') || flag('series')) {
  updateOptions.includeSeries = true;
} else if (flag('includeAuthor') || flag('author')) {
  updateOptions.includeAuthor = true;
} else if (flag('includeDescription') || flag('description')) {
  updateOptions.includeDescription = true;
} else if (flag('includeImages') || flag('images')) {
  // Implies the description refresh: the image list comes from the same scrape.
  updateOptions.includeDescription = true;
  updateOptions.includeImages = true;
} else if (flag('includeReviews') || flag('reviews')) {
  updateOptions.includeReviews = true;
}

performUpdate(updateOptions)
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    throw err;
  });
