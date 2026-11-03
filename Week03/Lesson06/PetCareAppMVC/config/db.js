const mysql = require('mysql2');

// MySQL Connection
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'Rp810810810!',
  database: 'petcare'
});

module.exports = connection;
