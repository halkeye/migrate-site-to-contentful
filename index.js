const fs = require('fs');
const path = require('path');
const frontmatter = require('frontmatter');
const mime = require('mime-types');
const contentful = require('contentful-management');
const program = require('commander');
const { keyBy } = require('lodash');


program.option('-s, --space', 'spaceid', process.env.SPACE_ID || 'nanc497ebrzi')
program.option('-e, --environment', 'environment', process.env.ENVIRONMENT_ID || 'master')
program.option('-a, --accessToken', 'access token', process.env.CONTENTFUL_MANAGEMENT_TOKEN)
program.option('-c, --changedir', 'Change to this content directory first', 'content')

program.parse(process.argv);

if (program.changedir) {
  process.chdir(program.changedir);
}
async function getOrCreateLink (environment, entries, link) {
  if (!entries.externalLink[link.url]) {
    const fields = {};

    for (const field of Object.keys(link)) {
      fields[field] = { 'en-US': link[field] };
    }
    entries.externalLink[link.url] = await environment.createEntry('externalLink', {
      fields: fields
    }).then(entry => entry.publish());
  }
  return entries.externalLink[link.url].sys.id;
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

async function main () {
  const client = contentful.createClient({ accessToken: program.accessToken });

  const environment = await client.getSpace(program.spaceId).then((space) => space.getEnvironment(program.environmentId));
  const content = { Assets: {}, externalLink: {} };

  const contentTypes = await environment.getContentTypes().then((response) => keyBy(response.items, 'sys.id'));
  Object.keys(contentTypes).forEach(contentType => { content[contentType] = {}; });

  // This API call will request a space with the specified ID
  const entries = await environment.getEntries().then((entries) => entries.items);

  for (const entry of entries) {
    const type = entry.sys.contentType.sys.id;
    const field = contentTypes[type].displayField;

    if (!content[type]) {
      content[type] = {};
    }
    if (!entry.fields[field]) {
      continue;
    }
    content[type][entry.fields[field]['en-US']] = entry;
  }

  // for (const type of ['posts', 'presentations', 'projects']) {
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
      for (const field of Object.keys(parsed.data)) {
        fields[field] = { 'en-US': parsed.data[field] };
      }
      if (slugField) {
        fields[slugField] = { 'en-US': dir };
        delete fields.post_id;
        delete fields.postId;
      }

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
      if (parsed.data.links) {
        fields.links = { 'en-US': [] };
        for (const link of parsed.data.links) {
          fields.links['en-US'].push({
            sys: {
              'type': 'Link',
              'linkType': 'Entry',
              'id': await getOrCreateLink(environment, content, link)
            }
          });
        }
      }
      if (content[entryType][parsed.data.title]) {
        const entry = content[entryType][parsed.data.title];
        Object.keys(fields).forEach(field => {
          entry[field] = fields[field];
        });
        await entry.update().then(entry => entry.publish());
      } else {
        await environment.createEntry(entryType, { fields: fields }).then(entry => entry.publish());
      }
    }
  }
}
main(); // .then(console.log, console.error);
