const fs = require('node:fs');
const path = require('node:path');

const schemaPath = path.join(process.cwd(), 'src', 'database', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const required = [
  'ALTER TABLE links ADD COLUMN IF NOT EXISTS lease_until TIMESTAMP;',
  'CREATE INDEX IF NOT EXISTS idx_links_lease_until',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_links_user_url_unique',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_dedupe_key',
];

for (const fragment of required) {
  if (!schema.includes(fragment)) {
    throw new Error('Schema contract missing: ' + fragment);
  }
}

if (schema.includes('\\n')) {
  throw new Error('Schema contains a literal escaped newline (\\n)');
}

console.log('Schema contract: OK');
