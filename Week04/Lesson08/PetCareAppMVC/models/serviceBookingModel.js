const connectionPool = require('../config/db');

function finishTransaction(dbConnection, error, result, callback) {
  try {
    dbConnection.release();
  } catch (releaseError) {
    if (error) {
      error.releaseError = releaseError;
    } else {
      error = releaseError;
      result = undefined;
    }
  }
  callback(error, result);
}

function rollback(dbConnection, error, result, callback) {
  dbConnection.rollback((rollbackError) => {
    if (rollbackError) {
      if (error) {
        error.rollbackError = rollbackError;
      } else {
        error = rollbackError;
        result = undefined;
      }
    }
    finishTransaction(dbConnection, error, result, callback);
  });
}

function createPendingBooking(ownerId, petId, serviceId, bookingDate, callback) {
  connectionPool.getConnection((connectionError, dbConnection) => {
    if (connectionError) return callback(connectionError);

    dbConnection.beginTransaction((beginError) => {
      if (beginError) {
        return finishTransaction(dbConnection, beginError, undefined, callback);
      }

      const bookingSql = `
        INSERT INTO service_bookings
          (pet_id, service_id, booking_status, booked_price, booking_date)
        SELECT pets.id, services.id, 'pending', services.price, ?
        FROM pets
        JOIN services ON services.id = ? AND services.is_active = 1
        WHERE pets.id = ? AND pets.owner_id = ?
      `;

      dbConnection.query(
        bookingSql,
        [bookingDate, serviceId, petId, ownerId],
        (bookingError, bookingResult) => {
          if (bookingError) {
            return rollback(dbConnection, bookingError, undefined, callback);
          }

          if (bookingResult.affectedRows !== 1) {
            return rollback(dbConnection, null, null, callback);
          }

          const bookingId = bookingResult.insertId;
          const paymentSql = `
            INSERT INTO payments (booking_id, amount, payment_status)
            SELECT id, booked_price, 'pending'
            FROM service_bookings
            WHERE id = ?
          `;

          dbConnection.query(paymentSql, [bookingId], (paymentError, paymentResult) => {
            if (paymentError) {
              return rollback(dbConnection, paymentError, undefined, callback);
            }

            if (paymentResult.affectedRows !== 1) {
              const error = new Error('Pending payment was not created for the booking.');
              return rollback(dbConnection, error, undefined, callback);
            }

            dbConnection.commit((commitError) => {
              if (commitError) {
                return rollback(dbConnection, commitError, undefined, callback);
              }

              return finishTransaction(dbConnection, null, {
                bookingId,
                paymentId: paymentResult.insertId
              }, callback);
            });
          });
        }
      );
    });
  });
}

function getBookingsByOwner(ownerId, callback) {
  const sql = `
    SELECT
      service_bookings.id AS booking_id,
      DATE_FORMAT(service_bookings.booking_date, '%Y-%m-%d') AS booking_date,
      pets.name AS pet_name,
      services.name AS service_name,
      service_bookings.booked_price,
      service_bookings.booking_status,
      payments.payment_status,
      payments.payment_reference,
      service_bookings.created_at
    FROM service_bookings
    JOIN pets ON pets.id = service_bookings.pet_id
    JOIN services ON services.id = service_bookings.service_id
    LEFT JOIN payments ON payments.booking_id = service_bookings.id
    WHERE pets.owner_id = ?
    ORDER BY service_bookings.created_at DESC, service_bookings.id DESC
  `;
  connectionPool.query(sql, [ownerId], callback);
}

module.exports = { createPendingBooking, getBookingsByOwner };
