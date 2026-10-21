require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    // Add the missing credits column
    await pool.query('ALTER TABLE courses ADD COLUMN credits INTEGER DEFAULT 3;');
    console.log('✅ Successfully added the "credits" column to the courses table!');
  } catch (e) {
    console.error('Error:', e.message);
  }
  process.exit(0);
}

run();