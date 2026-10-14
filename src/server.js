
import 'dotenv/config';
import app from './app.js';
import pool from './config/database.js';

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  try {
    // Verify that PostgreSQL is reachable before starting the API.
    await pool.query('SELECT 1');

    app.listen(PORT, () => {
      console.log(`Subscription platform running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start subscription platform:', error.message);
    process.exit(1);
  }
}

startServer();
