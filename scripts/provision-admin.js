const crypto = require('node:crypto');
const { Client } = require('pg');

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(`scrypt:${salt}:${key.toString('hex')}`)));
}

async function main() {
  const { DATABASE_URL, FORGE_ADMIN_EMAIL: email, FORGE_ADMIN_PASSWORD: password } = process.env;
  if (!DATABASE_URL || !email || !password) throw new Error('DATABASE_URL, FORGE_ADMIN_EMAIL, and FORGE_ADMIN_PASSWORD are required.');
  if (password.length < 16) throw new Error('FORGE_ADMIN_PASSWORD must be at least 16 characters.');
  const client = new Client({ connectionString: DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  await client.connect();
  try {
    const result = await client.query('INSERT INTO users(id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING id', [crypto.randomUUID(), email.toLowerCase(), await passwordHash(password), 'admin']);
    console.log(result.rowCount ? 'Administrator provisioned.' : 'Administrator already exists.');
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
