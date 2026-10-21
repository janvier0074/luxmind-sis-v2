require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function setup() {
  try {
    // 1. Add password column if missing
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT 'password123';`);
    
    // 2. Create a test Advisor if one doesn't exist
    const advisorCheck = await pool.query(`SELECT * FROM users WHERE role = 'advisor' LIMIT 1`);
    if (advisorCheck.rows.length === 0) {
      await pool.query(`INSERT INTO users (full_name, username, role, password) VALUES ('Dr. Smith', 'advisor1', 'advisor', 'password123')`);
      console.log('✅ Created test Advisor (username: advisor1, pass: password123)');
    }

    // 3. Make sure our test student has a password
    await pool.query(`UPDATE users SET password = 'password123' WHERE role = 'student'`);

    console.log('✅ Auth setup complete!');
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
setup();