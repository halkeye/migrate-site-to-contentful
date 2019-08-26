const fs = require('fs');
const path = require('path');
const frontmatter = require('frontmatter');
const mime = require('mime-types');
const contentful = require('contentful-management');
const program = require('commander');
const { keyBy } = require('lodash');


program.option('-s, --spaceId [space]', 'spaceid', process.env.SPACE_ID || 'nanc497ebrzi')
program.option('-e, --environmentId [environment]', 'environment', process.env.ENVIRONMENT_ID || 'master')
program.option('-a, --accessToken [token]', 'access token', process.env.CONTENTFUL_MANAGEMENT_TOKEN)
program.option('-c, --changedir [path]', 'Change to this content directory first', 'content')
program.option('-d, --deleteall', 'delete all')

program.parse(process.argv);

if (program.changedir) {
  process.chdir(program.changedir);
}

const getUniqueField = (contentType) => {
  const field = contentType.fields.find(f => f.validations.find(v => v.unique));
  if (!field) {
    console.log('field', contentType);
    throw Error('No unique field for ' + contentType.sys.id)
  }
  return field.id;
}
async function getOrCreateContent (contentType, contentTypes, environment, entries, data) {
  const uniqueField = getUniqueField(contentTypes[contentType])
  const key = data[uniqueField];

  if (!entries[contentType][key]) {
    const fields = {};

    for (const field of Object.keys(data)) {
      fields[field] = { 'en-US': data[field] };
    }
    try {
      entries[contentType][key] = await environment.createEntry(contentType, { fields: fields }).then(entry => entry.publish());
    } catch (err) {
      console.log({
        contentType,
        uniqueField,
        key,
        data,
        keys: Object.keys(entries[contentType]),
        contentTypes: Object.keys(entries)
      });
      throw err;
    }
  }
  return entries[contentType][key].sys.id;
}

async function getOrCreateAsset (environment, entries, filename) {
  const key = filename;
  if (!entries.Assets[key]) {
    entries.Assets[key] = await environment.createAssetFromFiles({
      fields: {
        title: {
          'en-US': filename
        },
        file: {
          'en-US': {
            contentType: mime.lookup(filename),
            fileName: filename,
            file: fs.createReadStream(filename)
          }
        }
      }
    })
      .then(asset => asset.processForAllLocales())
      .then(asset => asset.publish());
  }
  return entries.Assets[key].sys.id;
}

const getAllEntries = async (environment) => {
  const entries = [];
  let skip = 0;
  while (true) {
    const newEntries = await environment.getEntries({ skip: 0, limit: 1000, order: 'sys.createdAt' });
    skip = newEntries.skip + newEntries.limit

    Array.prototype.push.apply(entries, newEntries.items);

    console.log({
      'entries.length': entries.length,
      'newEntries.total': newEntries.total,
      bool: entries.length >= newEntries.total
    })
    if (entries.length >= newEntries.total) {
      break;
    }
  }
  return entries;
}

async function main () {
  const client = contentful.createClient({ accessToken: program.accessToken });

  const environment = await client.getSpace(program.spaceId).then((space) => space.getEnvironment(program.environmentId));
  const content = { Assets: {}, externalLink: {} };

  const contentTypes = await environment.getContentTypes().then((response) => keyBy(response.items, 'sys.id'));
  Object.keys(contentTypes).forEach(contentType => { content[contentType] = {}; });

  // This API call will request a space with the specified ID
  const entries = await getAllEntries(environment)

  if (program.deleteall) {
    for (const entry of entries) {
      await entry.unpublish().catch(() => {});
      await entry.delete();
    }
    return;
  }

  for (const entry of entries) {
    const type = entry.sys.contentType.sys.id;
    const uniqueField = getUniqueField(contentTypes[type])

    if (!content[type]) {
      content[type] = {};
    }
    if (!entry.fields[uniqueField]) {
      continue;
    }
    content[type][entry.fields[uniqueField]['en-US']] = entry;
  }

  for (const type of await fs.promises.readdir('.')) {
    const dirFiles = await fs.promises.readdir(type);
    for (const dir of dirFiles) {
      const entryType = type.replace(/s$/g, '');
      const file = path.join(type, dir, 'index.md');
      if (!fs.existsSync(file)) { continue; }
      const contentField = contentTypes[entryType].fields.find(f => f.type === 'Text').id;
      const slugField = contentTypes[entryType].fields.find(f => f.id === 'slug').id;

      const parsed = frontmatter(await fs.promises.readFile(file).then(buffer => buffer.toString('utf-8')));
      const fields = { [contentField]: { 'en-US': parsed.content } };
      if (slugField) {
        parsed.data.slug = parsed.data.post_name || dir;
        delete parsed.data.post_id;
        delete parsed.data.postId;
        delete parsed.data.post_name;
      }

      for (const field of Object.keys(parsed.data)) {
        if (field === 'date') {
          const hasTimezone = Boolean(parsed.data[field].toString().match(/(?:[-|+]\d{4}$|\d+Z$)/))
          parsed.data[field] = new Date(parsed.data[field] + (hasTimezone ? '' : '+0700')).getTime()
        }
        fields[field] = { 'en-US': parsed.data[field] };
      }
      delete fields.status;

      for (const imageField of ['image', 'cover']) {
        if (parsed.data[imageField]) {
          fields[imageField] = {
            'en-US': {
              sys: {
                'type': 'Link',
                'linkType': 'Asset',
                id: await getOrCreateAsset(environment, content, path.join(type, dir, parsed.data[imageField]))
              }
            }
          };
        }
      }
      if (parsed.data.attachments) {
        fields.attachments = { 'en-US': [] };
        for (const attachment of parsed.data.attachments) {
          fields.attachments['en-US'].push({
            sys: {
              'type': 'Link',
              'linkType': 'Asset',
              id: await getOrCreateAsset(environment, content, path.join(type, dir, attachment))
            }
          });
        }
      }
      if (parsed.data.author) {
        fields.author = {
          'en-US': {
            sys: {
              'type': 'Link',
              'linkType': 'Entry',
              'id': await getOrCreateContent('author', contentTypes, environment, content, { name: parsed.data.author, slug: parsed.data.author })
            }
          }
        };
      }
      if (parsed.data.category) {
        fields.category = { 'en-US': [] };
        for (const category of (Array.isArray(parsed.data.category) ? parsed.data.category : [parsed.data.category])) {
          fields.category['en-US'].push({
            sys: {
              'type': 'Link',
              'linkType': 'Entry',
              'id': await getOrCreateContent('category', contentTypes, environment, content, { title: category, slug: category })
            }
          });
        }
      }
      if (parsed.data.links) {
        fields.links = { 'en-US': [] };
        for (const link of parsed.data.links) {
          fields.links['en-US'].push({
            sys: {
              'type': 'Link',
              'linkType': 'Entry',
              'id': await getOrCreateContent('externalLink', contentTypes, environment, content, link)
            }
          });
        }
      }
      const uniqueField = getUniqueField(contentTypes[entryType])
      const entryKey = parsed.data[uniqueField];
      let entry = content[entryType][entryKey];
      try {
        if (entry) {
          Object.keys(fields).forEach(field => { entry[field] = fields[field]; });
          entry = await entry.update()
        } else {
          entry = await environment.createEntry(entryType, { fields: fields })
        }
      } catch (err) {
        console.log('fields', fields);
        throw err;
      }
      content[entryType][entryKey] = entry;

      if (parsed.data.status) {
        if (parsed.data.status === 'publish') {
          await entry.publish();
        }
      } else {
        await entry.publish();
      }

    }
  }
}
main(); // .then(console.log, console.error);
