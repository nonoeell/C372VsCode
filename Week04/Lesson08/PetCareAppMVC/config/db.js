const mysql = require('mysql2');

// MySQL Connection Pool
const connection = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'Rp810810810!',
  database: 'petcare',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = connection;
