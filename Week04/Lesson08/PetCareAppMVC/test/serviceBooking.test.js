const assert = require('node:assert/strict');
const test = require('node:test');

const bookingModelPath = require.resolve('../models/serviceBookingModel');
const serviceModelPath = require.resolve('../models/serviceModel');
const serviceControllerPath = require.resolve('../controllers/serviceController');
const dbConfigPath = require.resolve('../config/db');
const petModelPath = require.resolve('../models/petModel');

function withModuleStubs(stubs, callback) {
  const paths = Object.keys(stubs);
  const previous = new Map(paths.map((modulePath) => [
    modulePath,
    require.cache[modulePath]
  ]));

  for (const [modulePath, exports] of Object.entries(stubs)) {
    require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
  }

  try {
    return callback();
  } finally {
    for (const modulePath of paths) {
      if (previous.get(modulePath)) {
        require.cache[modulePath] = previous.get(modulePath);
      } else {
        delete require.cache[modulePath];
      }
    }
  }
}

function loadModelWithDatabase(modulePath, database) {
  delete require.cache[modulePath];
  return withModuleStubs({ [dbConfigPath]: database }, () => {
    const model = require(modulePath);
    delete require.cache[modulePath];
    return model;
  });
}

function loadBookingModel(pool) {
  return loadModelWithDatabase(bookingModelPath, pool);
}

function loadServiceModel(pool) {
  return loadModelWithDatabase(serviceModelPath, pool);
}

function loadServiceController(stubs) {
  delete require.cache[serviceControllerPath];
  return withModuleStubs(stubs, () => {
    const controller = require(serviceControllerPath);
    delete require.cache[serviceControllerPath];
    return controller;
  });
}

function createFakeConnection({
  bookingResult,
  bookingError,
  paymentResult,
  paymentError,
  commitError
} = {}) {
  const calls = [];
  const connection = {
    beginTransaction(callback) {
      calls.push('begin');
      callback(null);
    },
    query(sql, params, callback) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO service_bookings')) {
        callback(bookingError || null, bookingResult || { affectedRows: 1, insertId: 41 });
      } else {
        callback(paymentError || null, paymentResult || { affectedRows: 1, insertId: 52 });
      }
    },
    commit(callback) {
      calls.push('commit');
      callback(commitError || null);
    },
    rollback(callback) {
      calls.push('rollback');
      callback(null);
    },
    release() {
      calls.push('release');
    }
  };

  return { calls, connection };
}

function createPool(connection) {
  return {
    getConnection(callback) {
      callback(null, connection);
    },
    query() {
      assert.fail('Unexpected pool query in booking creation test');
    }
  };
}

function runBooking(model) {
  return new Promise((resolve) => {
    model.createPendingBooking(8, 5, 2, '2026-11-11', (error, result) => {
      resolve({ error, result });
    });
  });
}

function localToday() {
  return localDateWithOffset(0);
}

function localDateWithOffset(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

test('creates booking and pending payment in one transaction using stored price', async () => {
  const { calls, connection } = createFakeConnection();
  const model = loadBookingModel(createPool(connection));
  const outcome = await runBooking(model);

  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.result, { bookingId: 41, paymentId: 52 });
  assert.deepEqual(calls.map((call) => typeof call === 'string' ? call : 'query'), [
    'begin', 'query', 'query', 'commit', 'release'
  ]);
  assert.match(calls[1].sql, /services\.is_active = 1/);
  assert.match(calls[1].sql, /pets\.owner_id = \?/);
  assert.match(calls[1].sql, /services\.price/);
  assert.deepEqual(calls[1].params, ['2026-11-11', 2, 5, 8]);
  assert.match(calls[2].sql, /SELECT id, booked_price, 'pending'/);
  assert.deepEqual(calls[2].params, [41]);
});

test('rolls back and reports unavailable when pet ownership or service eligibility fails', async () => {
  const { calls, connection } = createFakeConnection({
    bookingResult: { affectedRows: 0, insertId: 0 }
  });
  const model = loadBookingModel(createPool(connection));
  const outcome = await runBooking(model);

  assert.equal(outcome.error, null);
  assert.equal(outcome.result, null);
  assert.deepEqual(calls, ['begin', calls[1], 'rollback', 'release']);
  assert.equal(calls[1].params[3], 8);
});

test('rolls back a failed payment insert and does not report success', async () => {
  const paymentError = new Error('payment insert failed');
  const { calls, connection } = createFakeConnection({ paymentError });
  const model = loadBookingModel(createPool(connection));
  const outcome = await runBooking(model);

  assert.equal(outcome.error, paymentError);
  assert.equal(outcome.result, undefined);
  assert.equal(calls.includes('rollback'), true);
  assert.equal(calls.includes('commit'), false);
  assert.equal(calls.at(-1), 'release');
});

test('rolls back a failed booking insert and releases its connection', async () => {
  const bookingError = new Error('booking insert failed');
  const { calls, connection } = createFakeConnection({ bookingError });
  const model = loadBookingModel(createPool(connection));
  const outcome = await runBooking(model);

  assert.equal(outcome.error, bookingError);
  assert.equal(outcome.result, undefined);
  assert.deepEqual(calls.map((call) => typeof call === 'string' ? call : 'query'), [
    'begin', 'query', 'rollback', 'release'
  ]);
});

test('rolls back when commit fails and propagates the failure', async () => {
  const commitError = new Error('commit failed');
  const { calls, connection } = createFakeConnection({ commitError });
  const model = loadBookingModel(createPool(connection));
  const outcome = await runBooking(model);

  assert.equal(outcome.error, commitError);
  assert.equal(outcome.result, undefined);
  assert.equal(calls.includes('rollback'), true);
  assert.equal(calls.at(-1), 'release');
});

test('rejects invalid IDs and dates before asking the model to create a booking', () => {
  const calls = [];
  const controller = loadServiceController({
    [petModelPath]: {},
    [serviceModelPath]: {},
    [require.resolve('../models/serviceBookingModel')]: {
      createPendingBooking() {
        calls.push('create');
      }
    }
  });
  const errorMessages = [];
  const redirects = [];
  const response = {
    redirect(pathname) {
      redirects.push(pathname);
    }
  };

  for (const body of [
    { petId: '', serviceId: '2', bookingDate: '2026-11-11' },
    { petId: '-1', serviceId: '2', bookingDate: '2026-11-11' },
    { petId: '5', serviceId: 'unknown', bookingDate: '2026-11-11' },
    { petId: '5', serviceId: '0', bookingDate: '2026-11-11' },
    { petId: '5', serviceId: '2' },
    { petId: '5', serviceId: '2', bookingDate: '2026/11/11' },
    { petId: '5', serviceId: '2', bookingDate: '2026-02-30' },
    { petId: '5', serviceId: '2', bookingDate: '2020-01-01' }
  ]) {
    controller.createBooking({
      body,
      session: { user: { id: 8 } },
      flash(type, message) {
        if (type === 'error') errorMessages.push(message);
      }
    }, response);
  }

  assert.deepEqual(calls, []);
  assert.deepEqual(redirects, Array(8).fill('/services'));
  assert.equal(errorMessages.every(
    (message) => message === 'Choose a pet, service, and valid booking date.'
  ), true);
});

test('accepts today and future dates and redirects only after committed success', () => {
  const calls = [];
  const bookingDates = [localToday(), localDateWithOffset(1)];
  const controller = loadServiceController({
    [petModelPath]: {},
    [serviceModelPath]: {},
    [require.resolve('../models/serviceBookingModel')]: {
      createPendingBooking(ownerId, petId, serviceId, date, callback) {
        calls.push([ownerId, petId, serviceId, date]);
        callback(null, { bookingId: 41, paymentId: 52 });
      }
    }
  });
  const flashes = [];
  const redirects = [];

  for (const bookingDate of bookingDates) {
    controller.createBooking({
      body: { petId: '5', serviceId: '2', bookingDate },
      session: { user: { id: 8 } },
      flash(type, message) {
        flashes.push([type, message]);
      }
    }, {
      redirect(pathname) {
        redirects.push(pathname);
      }
    });
  }

  assert.deepEqual(calls, bookingDates.map((date) => [8, 5, 2, date]));
  assert.deepEqual(redirects, ['/bookings', '/bookings']);
  assert.deepEqual(flashes, Array(2).fill([
    'success',
    'Booking created. Payment is pending; no payment has been processed.'
  ]));
});

test('rejects unavailable pets or services without redirecting as a success', () => {
  const controller = loadServiceController({
    [petModelPath]: {},
    [serviceModelPath]: {},
    [require.resolve('../models/serviceBookingModel')]: {
      createPendingBooking(ownerId, petId, serviceId, date, callback) {
        callback(null, null);
      }
    }
  });
  const flashes = [];
  const redirects = [];

  controller.createBooking({
    body: { petId: '5', serviceId: '2', bookingDate: localToday() },
    session: { user: { id: 8 } },
    flash(type, message) {
      flashes.push([type, message]);
    }
  }, {
    redirect(pathname) {
      redirects.push(pathname);
    }
  });

  assert.deepEqual(redirects, ['/services']);
  assert.deepEqual(flashes, [[
    'error',
    'That pet or service is unavailable for booking.'
  ]]);
});

test('logs a save failure and redirects with the submitted pet preselection', () => {
  const failure = new Error('database unavailable');
  const controller = loadServiceController({
    [petModelPath]: {},
    [serviceModelPath]: {},
    [require.resolve('../models/serviceBookingModel')]: {
      createPendingBooking(ownerId, petId, serviceId, date, callback) {
        callback(failure);
      }
    }
  });
  const flashes = [];
  const redirects = [];
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    controller.createBooking({
      body: { petId: '5', serviceId: '2', bookingDate: localToday() },
      session: { user: { id: 8 } },
      flash(type, message) {
        flashes.push([type, message]);
      }
    }, {
      redirect(pathname) {
        redirects.push(pathname);
      }
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(redirects, ['/services?petId=5']);
  assert.deepEqual(flashes, [[
    'error',
    'Unable to create the booking. Please try again.'
  ]]);
});

test('loads active services from the database in name order', () => {
  let query;
  const model = loadServiceModel({
    query(sql, callback) {
      query = sql;
      callback(null, [{ id: 2, name: 'Bath', price: '25.00' }]);
    }
  });

  model.getActiveServices((error, services) => {
    assert.equal(error, null);
    assert.deepEqual(services, [{ id: 2, name: 'Bath', price: '25.00' }]);
  });
  assert.match(query, /WHERE is_active = 1/);
  assert.match(query, /ORDER BY name/);
});

test('queries history by owner with payments optional and newest bookings first', () => {
  let query;
  let parameters;
  const model = loadBookingModel({
    query(sql, params, callback) {
      query = sql;
      parameters = params;
      callback(null, []);
    },
    getConnection() {
      assert.fail('Unexpected connection acquisition in history query test');
    }
  });

  model.getBookingsByOwner(8, (error, bookings) => {
    assert.equal(error, null);
    assert.deepEqual(bookings, []);
  });
  assert.deepEqual(parameters, [8]);
  assert.match(query, /WHERE pets\.owner_id = \?/);
  assert.match(query, /LEFT JOIN payments/);
  assert.match(query, /ORDER BY service_bookings\.created_at DESC, service_bookings\.id DESC/);
});

test('renders services with only an owned pet preselected and complete locals', () => {
  const pets = [
    { id: 5, name: 'Mira', species: 'Cat' },
    { id: 6, name: 'Molly', species: 'Dog' }
  ];
  const services = [{ id: 2, name: 'Basic Bath', price: '25.00' }];
  const controller = loadServiceController({
    [petModelPath]: {
      getPetsByOwner(ownerId, callback) {
        assert.equal(ownerId, 8);
        callback(null, pets);
      }
    },
    [serviceModelPath]: {
      getActiveServices(callback) {
        callback(null, services);
      }
    },
    [bookingModelPath]: {}
  });
  const render = [];
  const response = {
    render(view, locals) {
      render.push({ view, locals });
    }
  };

  controller.listServices({
    query: { petId: '5' },
    session: { user: { id: 8 } },
    flash(type) {
      return type === 'success' ? ['ok'] : [];
    }
  }, response);

  assert.equal(render[0].view, 'services');
  assert.deepEqual(render[0].locals.pets, pets);
  assert.deepEqual(render[0].locals.services, services);
  assert.equal(render[0].locals.selectedPetId, '5');
  assert.equal(render[0].locals.today, localToday());
  assert.deepEqual(render[0].locals.messages, ['ok']);
  assert.deepEqual(render[0].locals.errors, []);
  assert.ok(render[0].locals.session);
});

test('renders booking history for the signed-in owner', () => {
  const bookings = [{
    booking_id: 41,
    booking_date: localToday(),
    pet_name: 'Mira',
    service_name: 'Basic Bath',
    booked_price: '25.00',
    booking_status: 'pending',
    payment_status: 'pending'
  }];
  let requestedOwner;
  const controller = loadServiceController({
    [petModelPath]: {},
    [serviceModelPath]: {},
    [bookingModelPath]: {
      getBookingsByOwner(ownerId, callback) {
        requestedOwner = ownerId;
        callback(null, bookings);
      }
    }
  });
  const render = [];

  controller.listBookings({
    session: { user: { id: 8 } },
    flash() {
      return [];
    }
  }, {
    render(view, locals) {
      render.push({ view, locals });
    }
  });

  assert.equal(requestedOwner, 8);
  assert.equal(render[0].view, 'bookings');
  assert.deepEqual(render[0].locals.bookings, bookings);
});
