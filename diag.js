require('dotenv').config();
const { Pool } = require('pg');

console.log('--- ENV CHECK ---');
console.log('URL starts with:', process.env.DATABASE_URL ? process.env.DATABASE_URL.slice(0, 30) + '...' : 'MISSING');
console.log('URL length:', process.env.DATABASE_URL ? process.env.DATABASE_URL.length : 0);
console.log('--- CONNECTING ---');

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

async function diag() {
  try {
    const test = await pool.query('SELECT 1 as ok');
    console.log('✅ Connection OK');

    const coursesCols = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'courses'
    `);
    console.log('courses columns:', coursesCols.rows.map(r => r.column_name).join(', '));

    const regCols = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'course_registrations'
    `);
    console.log('course_registrations columns:', regCols.rows.map(r => r.column_name).join(', '));

    const courseCount = await pool.query(`SELECT COUNT(*) FROM courses`);
    console.log('Total courses:', courseCount.rows[0].count);

  } catch (err) {
    console.error("❌ FULL ERROR:", err);
    console.error("❌ Code:", err.code);
    console.error("❌ Message:", err.message);
    console.error("❌ Detail:", err.detail);
    console.error("❌ Stack:", err.stack);
  }
  process.exit(0);
}
diag();