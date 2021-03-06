"use strict";

var debug         = require('debug')('base:stats');
var assert        = require('assert');
var _             = require('lodash');
var Promise       = require('promise');
var request       = require('superagent-promise');
var url           = require('url');
var urljoin       = require('url-join');
var series        = require('./series');
var events        = require('events');
var util          = require('util');

// Export types and series as defined in series module
// This is to make them available as `base.stats.Series`.
exports.types = series.types;
exports.Series = series.Series;

/**
 * Create an Influx Database Connection
 *
 * options:
 * {
 *   // Connection string for
 *   connectionString:  '<protocol>://<user>:<pwd>@<host>:<port>/db/<database>',
 *
 *   // Max submission delay
 *   maxDelay:          60 * 5, // 5 minutes
 *
 *   // Maximum number of pending points before writing
 *   maxPendingPoints:  250,
 *
 *   // Allow the connection string to use HTTP instead of HTTPS, this option
 *   // is just to prevent accidental deployments with HTTP instead of HTTPS
 *   // (there is no reason not to use HTTPS).
 *   allowHTTP:         false
 * }
 */
var Influx = function(options) {
  assert(options,                   "options are required");
  assert(options.connectionString,  "options.connectionString is missing");
  assert(url.parse(options.connectionString).protocol === 'https:' ||
         options.allowHTTP, "InfluxDB connectionString must use HTTPS!");
  options = _.defaults({}, options, {
    maxDelay:             60 * 5,
    maxPendingPoints:     250
  });
  this._options           = options;
  this._pendingPoints     = {};
  this._nbPendingPoints   = 0;
  this._flushTimeout = setTimeout(
    this.flush.bind(this, true),
    options.maxDelay * 1000
  );
};

/** Flush data to InfluxDB and optionally `restart` the timer */
Influx.prototype.flush = function(restart) {
  var that = this;

  // Clear timeout if asked to restart
  if (restart) {
    clearTimeout(this._flushTimeout);
    this._flushTimeout = null;
  }

  // Send points
  var done = Promise.resolve(null);
  if (this._nbPendingPoints > 0) {
    debug("Sending points to influxdb");

    // Prepare payload for transmission
    var payload = _.values(this._pendingPoints);
    payload.forEach(function(entry) {
      var nbCols = entry.columns.length;
      // Extend all points with some null properties, in case columns were added
      // after the initial creation
      entry.points.forEach(function(p) {
        p.length = nbCols;
      });
    });

    // Reset internals
    this._pendingPoints = {};
    this._nbPendingPoints = 0;

    // Send data
    done = request
      .post(urljoin(this._options.connectionString, 'series'))
      .query({
        time_precision: 'ms'
      })
      .send(payload)
      .end()
      .then(function(res) {
        // Handle errors
        if (!res.ok) {
          throw new Error("Request failed with HTTP code: " + res.status);
        }
      }).then(null, function(err) {
        debug("Failed to send to influxdb, err: %s, %j", err, err, err.stack);
      });
  }

  // Restart if requested
  if (restart) {
    done = done.then(function() {
      // Schedule the next flush
      this._flushTimeout = setTimeout(
        that.flush.bind(that, true),
        that._options.maxDelay * 1000
      );
    });
  }

  return done;
};

/** Flush a close InfluxDB connection */
Influx.prototype.close = function() {
  var that = this;
  clearTimeout(this._flushTimeout);
  this._flushTimeout = null;
  return that.flush(false);
};

/**
 * Add a new point to be saved in `series`.
 *
 * Example:
 *
 *     influx.addPoint('responseTime', {
 *       duration:   251
 *     });
 *
 */
Influx.prototype.addPoint = function(series, point) {
  // Get entry and create one if we don't have one
  var entry = this._pendingPoints[series];
  if (!entry) {
    entry = this._pendingPoints[series] = {
      name:     series,
      columns:  ['time'],
      points:   []
    };
  }

  // Transform point to list form
  var value = [new Date().getTime()];
  _.forIn(point, function(val, col) {
    // Find index for value
    var index = entry.columns.indexOf(col);
    // If it's not in columns, we add it
    if (index === -1) {
      entry.columns.push(col);
      var nbCols = entry.columns.length;
      index = nbCols - 1;
    }

    // Set the value
    value[index] = val;
  });

  // Add point to list of pending points
  entry.points.push(value);
  this._nbPendingPoints += 1;

  // Flush if we have too many points
  if (this._nbPendingPoints >= this._options.maxPendingPoints) {
    this.flush(true);
  }
};

/** Get the number of point currently waiting for submission*/
Influx.prototype.pendingPoints = function() {
  return this._nbPendingPoints;
};

/** Run a query on the influx db */
Influx.prototype.query = function(query) {
  return request
    .get(urljoin(this._options.connectionString, 'series'))
    .query({
      time_precision: 'ms',
      q: query,
    })
    .end()
    .then(function(res) {
      // Handle errors
      if (res.ok) {
        return res.body;
      } else {
        throw new Error("Request failed with HTTP code: " + res.status);
      }
    }).then(null, function(err) {
      debug("Failed to query influxdb, err: %s, %j", err, err, err.stack);
    });
};

// Export Influx
exports.Influx = Influx;


/**
 * Alternative statistics drain that acts like Influx,
 * But drops all points when flushed, useful for tests, when you need to create
 * a mock API or a mock exchange.
 */
var NullDrain = function() {
  this._nbPendingPoints = 0;
};
util.inherits(NullDrain, events.EventEmitter);

/** Drop point counter */
NullDrain.prototype.flush = function() {
  this._nbPendingPoints = 0
  return Promise.resolve(undefined);
};

/** Increment point counter */
NullDrain.prototype.addPoint = function(series, point) {
  debug("NullDrain.addPoint(%s, %j)", series, point);
  this._nbPendingPoints += 1;
  this.emit('point', series, point);
};

/** Drop point counter */
NullDrain.prototype.close = function() {
  return this.flush();
};

/** Return number of points that would be pending */
NullDrain.prototype.pendingPoints = function() {
  return this._nbPendingPoints;
};

// Export NullDrain
exports.NullDrain = NullDrain;

/**
 * Create some express middleware that will send a point to `reporter` with
 * the following columns:
 *
 * columns:
 * {
 *   duration:                stats.types.Number,  // Response time in ms
 *   statusCode:              stats.types.Number,  // Response status code
 *   requesstMethod:          stats.types.String,  // Request method
 *   param<req.params...>:    stats.types.String   // Request URL parameters
 * }
 *
 * As we include `req.params` prefixed with `param` it's necessary for the
 * reporter to accept `additionalColumns` of type `String` or `Any`.
 *
 * You may define additional values to be submitted with the ping using the
 * `additionalValues` object. This is useful if you create one middleware
 * instance of each HTTP end-point and add a key like `name`.
 */
var createResponseTimer = function(reporter, additionalValues) {
  return function(req, res, next) {
    var sent = false;
    var start = process.hrtime();
    var send = function() {
      try {
        // Don't send twice
        if (sent) {
          return;
        }
        sent = true;

        // Get duration
        var d = process.hrtime(start);

        var params = _.transform(req.params, function(result, value, key) {
          // Prefix the parameter keys
          result['param' + key[0].toUpperCase() + key.slice(1)] = value + '';
        });

        // Construct point
        var point = _.defaults({
          // Convert to milliseconds
          duration:       d[0] * 1000 + (d[1] / 1000000),
          requestMethod:  req.method.toLowerCase(),
          statusCode:     res.statusCode
        }, additionalValues, params);

        // Send point to reporter
        reporter(point);
      }
      catch(err) {
        debug("Error while compiling response times: %s, %j",
              err, err, err.stack);
      }
    };

    res.once('finish', send);
    res.once('close', send);
    next();
  };
};

// Export createResponseTimer
exports.createResponseTimer = createResponseTimer;

/**
 * Create a handler timer for AMQP messages received through
 * taskcluster-client. Please note, that this relies on that messages format.
 *
 * options:
 * {
 *   drain:        new Influx(...),  // Place to send events
 *   component:    'queue'           // Identifier for taskcluster component
 * }
 */
var createHandlerTimer = function(handler, options) {
  assert(handler instanceof Function, "A handler must be provided");
  assert(options,                     "options required");
  assert(options.drain,               "options.drain is required");
  assert(options.component,           "options.component is required");

  // Create a reporter
  var reporter = series.HandlerReports.reporter(options.drain);

  // Wrap handler and let that be it
  return function(message) {
    // Create most of the point
    var point = {
      component:      options.component,
      duration:       undefined,
      exchange:       message.exchange || '',
      redelivered:    (message.redelivered ? 'true' : 'false'),
      error:          'false'
    };

    // Start timer
    var start = process.hrtime();

    // Handle the message
    return Promise.resolve(handler(message)).then(function() {
      // Get duration
      var d = process.hrtime(start);

      // Convert to milliseconds
      point.duration = d[0] * 1000 + (d[1] / 1000000);

      // Send point to reporter
      reporter(point);
    }, function(err) {
      // Get duration
      var d = process.hrtime(start);

      // Convert to milliseconds
      point.duration = d[0] * 1000 + (d[1] / 1000000);

      // Flag and error
      point.error = 'true';

      // Send point to reporter
      reporter(point);

      // Re-throw the error
      throw err;
    });
  };
};

// Export createHandlerTimer
exports.createHandlerTimer = createHandlerTimer;


/** Interval handle for process usage monitoring */
var _processUsageReportingInterval = null;

/**
 * Monitor CPU and memory for this instance.
 *
 * options: {
 *   drain:        new Influx(...), // Place to send the pings
 *   interval:     60,              // Report every 1 minute
 *   component:    'queue',         // Identifier for the taskcluster component
 *   process:      'server'         // Process name
 * }
 *
 * Note, this is global in the current process.
 */
var startProcessUsageReporting = function(options) {
  // Validate options
  assert(options,           "Options are required");
  assert(options.drain,     "A drain for the measurements must be provided!");
  assert(options.component, "A component must be specified");
  assert(options.process,   "A process name must be specified");

  // Provide default options
  options = _.defaults({}, options, {
    interval:         60
  });

  // Clear reporting if already started
  if (_processUsageReportingInterval) {
    debug("WARNING: startProcessUsageReporting() already started!");
    clearInterval(_processUsageReportingInterval);
    _processUsageReportingInterval = null;
  }

  // Lazy load the usage monitor module
  var usage = require('usage');

  // Create reporter
  var reporter = series.UsageReports.reporter(options.drain);

  // Set interval to report usage at interval
  _processUsageReportingInterval = setInterval(function() {
    // Lookup usage for the current process
    usage.lookup(process.pid, {keepHistory: true}, function(err, result) {
      // Check for error
      if (err) {
        debug("Failed to get usage statistics, err: %s, %j",
              err, err, err.stack);
        return;
      }

      // Report usage
      reporter({
        component:      options.component,
        process:        options.process,
        cpu:            result.cpu,
        memory:         result.memory
      });
    });
  }, options.interval * 1000);
};

/** Stop process usage reporting */
var stopProcessUsageReporting = function() {
  if (_processUsageReportingInterval) {
    clearInterval(_processUsageReportingInterval);
    _processUsageReportingInterval = null;
  }
}

// Export startProcessUsageReporting and stopProcessUsageReporting
exports.startProcessUsageReporting  = startProcessUsageReporting;
exports.stopProcessUsageReporting   = stopProcessUsageReporting;


/**
 * Create a stats handler for taskcluster-client clients which takes an option
 * `stats` as function that will be call after an API call.
 *
 * options:
 * {
 *   tags: {                         // Tags as key/value (both strings)
 *     component: 'queue',           // Component identifier
 *     process:   'web'              // Process identifier
 *     // Common tags that are good to use includes:
 *     //     component, process, provisionerId, workerType
 *   },
 *   drain:        new Influx(...),  // Place to send events
 * }
 */
var createAPIClientStatsHandler = function(options) {
  options = _.defaults({}, options || {}, {
    tags:   {},
    drain:  undefined
  });
  assert(options.drain,                     "options.drain is required");
  assert(typeof options.tags === 'object',  "options.tags is required");
  assert(_.intersection(
    _.keys(options.tags), series.APIClientCalls.columns()
  ).length === 0, "Can't used reserved tag names!");

  // Create a reporter
  return series.APIClientCalls.reporter(options.drain, options.tags);
};

// Export createAPIClientStatsHandler
exports.createAPIClientStatsHandler = createAPIClientStatsHandler;