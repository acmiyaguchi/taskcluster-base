"use strict";

var assert        = require('assert');
var debug         = require('debug')('base:exchanges');
var _             = require('lodash');
var Promise       = require('promise');
var path          = require('path');
var fs            = require('fs');
var Validator     = require('./validator').Validator;
var aws           = require('aws-sdk-promise');
var amqplib       = require('amqplib');
var events        = require('events');
var util          = require('util');
var series        = require('./lib/series');

/** Class for publishing to a set of declared exchanges */
var Publisher = function(conn, channel, entries, exchangePrefix, options) {
  events.EventEmitter.call(this);
  assert(options.validator instanceof Validator,
         "options.validator must be an instance of Validator");
  this._conn = conn;
  this._channel = channel;
  this._entries = entries;
  this._options = options;
  if (options.drain) {
    assert(options.component, "component name for statistics is required");
    assert(options.process,   "process name for statistics is required");
    this._reporter = series.ExchangeReports.reporter(options.drain);
  }

  var that = this;
  this._channel.on('error', function(err) {
    debug("Channel error in Publisher: ", err.stack);
    that.emit('error', err);
  });
  this._conn.on('error', function(err) {
    debug("Connection error in Publisher: ", err.stack);
    that.emit('error', err);
  });

  entries.forEach(function(entry) {
    that[entry.name] = function() {
      // Copy arguments
      var args = Array.prototype.slice.call(arguments);

      // Construct message and routing key from arguments
      var message     = entry.messageBuilder.apply(undefined, args);
      var routingKey  = entry.routingKeyBuilder.apply(undefined, args);
      var CCs         = entry.CCBuilder.apply(undefined, args);
      assert(CCs instanceof Array, "CCBuilder must return an array");

      // Validate against schema
      var errors = that._options.validator.check(message, entry.schema);
      if (errors) {
        debug("Failed validate message: %j against schema: %s, errors: %j",
              message, entry.schema, errors);
        var error = new Error("Message validation failed");
        error.errors = errors;
        throw error;
      }

      // Convert routingKey to string if needed
      if (typeof(routingKey) !== 'string') {
        routingKey = entry.routingKey.map(function(key) {
          var word = routingKey[key.name];
          if (key.constant) {
            word = key.constant;
          }
          if (!key.required && (word === undefined || word === null)) {
            word = '_';
          }
          // Convert numbers to strings
          if (typeof(word) === 'number') {
            word = '' + word;
          }
          assert(typeof(word) === 'string', "non-string routingKey entry: "
                                            + key.name);
          assert(word.length <= key.maxSize,
                 "routingKey word: '" + word + "' for '" + key.name +
                 "' is longer than maxSize: " + key.maxSize);
          if (!key.multipleWords) {
            assert(word.indexOf('.') === -1, "routingKey for " + key.name +
                   " is not declared multipleWords and cannot contain '.' " +
                   "as is the case with '" + word + "'");
          }
          return word;
        }).join('.')
      }
      // Ensure the routing key is a string
      assert(typeof(routingKey) === 'string', "routingKey must be a string");

      // Serialize message to buffer
      var payload = new Buffer(JSON.stringify(message), 'utf8');

      // Find exchange name
      var exchange = exchangePrefix + entry.exchange;

      // Log that we're publishing a message
      debug("Publishing message on exchange: %s", exchange);

      // Return promise
      return new Promise(function(accept, reject) {
        // Start timer
        var start = null;
        if (that._reporter) {
          start = process.hrtime();
        }

        // Publish message
        that._channel.publish(exchange, routingKey, payload, {
          persistent:         true,
          contentType:        'application/json',
          contentEncoding:    'utf-8',
          CC:                 CCs
        }, function(err, val) {
          if (that._reporter) {
            // Get duration
            var d = process.hrtime(start);

            // Report statistics
            that._reporter({
              component:      options.component,
              process:        options.process,
              duration:       d[0] * 1000 + (d[1] / 1000000),
              routingKeys:    1 + CCs.length,
              payloadSize:    payload.length,
              exchange:       exchange,
              error:          (err ? 'true' : 'false'),
            });
          }

          // Handle errors
          if (err) {
            debug("Failed to publish message: %j and routingKey: %s, " +
                  "with error: %s, %j", message, routingKey, err, err);
            return reject(err);
          }
          accept(val);
        });
      });
    };
  });
};

// Inherit from events.EventEmitter
util.inherits(Publisher, events.EventEmitter);

/** Close the connection */
Publisher.prototype.close = function() {
  return this._conn.close();
};


/** Create a collection of exchange declarations
 *
 * options:
 * {
 *   title:              "Title of documentation page",
 *   description:        "Description in markdown",
 *   exchangePrefix:     'prefix/'            // For all exchanges declared here
 *   schemaPrefix:       "http://schemas...", // Prefix for all schemas
 *   durableExchanges:   true || false // If exchanges are durable
 * }
 *
 * You may choose the provide all the options now or later. Normally it makes
 * sense to declare title and description immediately, but leave exchangePrefix
 * and connection string as configurable things defined at runtime.
 */
var Exchanges = function(options) {
  this._entries = [];
  this._options = {
    exchangePrefix:       '',
    durableExchanges:     true,
    schemaPrefix:         ''
  };
  assert(options.title,       "title must be provided");
  assert(options.description, "description must be provided");
  this.configure(options);
};

/** Declare an new exchange
 *
 * options:
 * {
 *   exchange:     'exchange-name',      // exchange identifier on AMQP
 *   name:         "name_for_clients",   // name usable in client APIs
 *   title:        "Exchange title",
 *   description:  "Exchange description in markdown",
 *   routingKey: [ // Description of words, that make up the routing key
 *     {
 *       name:           'name_of_key',  // name of key for client APIs
 *       summary:        "Details in **markdown**",  // For documentation
 *       multipleWords:  true || false,  // true, if entry can contain dot
 *       required:       true || false,  // true, if a value is required
 *       constant:      'constant',      // Constant value, always this value
 *       maxSize:        22,             // Maximum size of word
 *     },
 *     // More entries...
 *   ],
 *   schema:       'http://schemas...'   // Message schema
 *   messageBuilder: function() {...}    // Return message from arguments given
 *   routingKeyBuilder: function() {...} // Return routing key from arguments
 *   CCBuilder: function() {...}         // Return list of CC'ed routing keys
 * }
 *
 * Remark, it is only possible to have one routing key entry that has the
 * multipleWords entry set to true. This restriction is necessary to facilitate
 * automatic parsing of the routing key.
 *
 * When a publisher is constructor with `connect` the `name` from options will
 * be the identifier for the method used to publish messages. The arguments
 * passed to this method will be passed to both `messageBuilder` and
 * `routingKeyBuilder`.
 *
 * Note, `routingKeyBuilder` may return either a string, or an object mapping
 * from name of routingKey entries to string values. If returning an object
 * then `maxSize` will be checked for all entries, as will `required`, and if
 * `required` is `false` the entry will default to `_` if no value is provided.
 * (It's not recommended to return a string).
 */
Exchanges.prototype.declare = function(options) {
  assert(options, "options must be given to declare");

  // Check that we have properties that must be strings
  [
    'exchange', 'name', 'title', 'description', 'schema'
  ].forEach(function(key) {
    assert(typeof(options[key]) === 'string', "Option: '" + key + "' must be " +
           "a string");
  });

  // Prefix schemas if a prefix is declared
  if (this._options.schemaPrefix) {
    options.schema = this._options.schemaPrefix + options.schema;
  }

  // Validate routingKey declaration
  assert(options.routingKey instanceof Array,
         "routingKey must be an array");

  var keyNames = [];
  var sizeLeft = 255;
  var firstMultiWordKey = null;
  options.routingKey.forEach(function(key) {
    // Check that the key name is unique
    assert(keyNames.indexOf(key.name) === -1, "Can't have two routing key " +
           "entries named: '" + key.name + "'");
    keyNames.push(key.name);
    // Check that we have a summary
    assert(typeof(key.summary) === 'string', "summary of routingKey entry " +
           "must be provided.");

    // Ensure that have a boolean value for simplicity
    key.multipleWords = (key.multipleWords ? true : false);
    key.required      = (key.required ? true : false);

    // Check that we only have one multipleWords key in the routing key. If we
    // have more than one then we can't really parse the routing key
    // automatically. And technically, there is probably little need for two
    // multiple word routing key entries.
    // Note: if the need arises we should probably consider CC'ing multiple
    // routing keys, or something like that. At least that is a possible cleaner
    // design solution.
    if (key.multipleWords) {
      assert(firstMultiWordKey === null,
             "Can't have two multipleWord entries in a routing key, " +
             "here we have both '" + firstMultiWordKey + "' and " +
             "'" + key.name + "'");
      firstMultiWordKey = key.name;
    }

    if (key.constant) {
      // Check that any constant is indeed a string
      assert(typeof(key.constant) === 'string',
             "constant must be a string, if provided");

      // Set maxSize
      if (!key.maxSize) {
        key.maxSize = key.constant.length;
      }
    }

    // Check that we have a maxSize
    assert(typeof(key.maxSize) == 'number' && key.maxSize > 0,
           "routingKey declaration " + key.name + " must have maxSize > 0");

    // Check size left in routingKey space
    if (sizeLeft != 255) {
      sizeLeft -= 1; // Remove on for the joining dot
    }
    sizeLeft -= key.maxSize;
    assert(sizeLeft >= 0, "Combined routingKey cannot be larger than 255 " +
           "including joining dots");
  });

  // Validate messageBuilder
  assert(options.messageBuilder instanceof Function,
         "messageBuilder must be a Function");

  // Validate routingKeyBuilder
  assert(options.routingKeyBuilder instanceof Function,
         "routingKeyBuilder must be a function");

  // Validate CCBuilder
  assert(options.CCBuilder instanceof Function,
         "CCBuilder must be a function");

  // Check that `exchange` and `name` are unique
  this._entries.forEach(function(entry) {
    assert(entry.exchange !== options.exchange,
           "Cannot have two declarations with exchange: '" +
           entry.exchange + "'");
    assert(entry.name !== options.name,
           "Cannot have two declarations with name: '" + entry.name + "'");
  });

  // Add options to set of options
  this._entries.push(options);
};

/** Configure the events declaration */
Exchanges.prototype.configure = function(options) {
  this._options = _.defaults({}, options, this._options);
};

/**
 * Connect by AMQP and create a publisher
 *
 * Options:
 * {
 *   credentials: {
 *     username:        '...',   // Pulse username
 *     password:        '...',   // Pulse password
 *     hostname:        '...'    // Hostname, defaults to pulse.mozilla.org
 *   },
 *   connectionString:  '...',   // AMQP connection string, if not credentials
 *   exchangePrefix:    '...',   // Exchange prefix
 *   validator:                  // Instance of base.validator.Validator
 *   drain:             new stats.Influx(...),  // Statistics drain
 *   component:         'queue'  // Component name in statistics
 *   process:           'server' // process name in statistics
 * }
 *
 * This method will connect to AMQP server and return a instance of Publisher.
 * The publisher will have a method for each declared exchange, the method
 * will carry the `name` given when the exchange was declared.
 *
 * In case of connection or internal errors the publisher will emit the `error`
 * event and all further attempts to use it will fail. In the future we may
 * implement a form of reconnection, but for now, just leave the `error` events
 * unhandled and let the process restart on its own.
 *
 * Return a promise for an instance of `Publisher`.
 */
Exchanges.prototype.connect = function(options) {
  options = _.defaults({}, options || {}, this._options, {
    credentials:        {}
  });

  // Check we have a connection string
  assert(options.connectionString ||
         (options.credentials.username && options.credentials.password),
         "ConnectionString or credentials must be provided");
  assert(options.validator instanceof Validator,
         "An instance of base.validator.Validator must be given");
  if (options.drain) {
    assert(options.component, "component name for statistics is required");
    assert(options.process,   "process name for statistics is required");
  }

  // Find exchange prefix, may be further prefixed if pulse credentials
  // are given
  var exchangePrefix = options.exchangePrefix;

  // If we have pulse credentials, construct connectionString
  if (options.credentials &&
      options.credentials.username &&
      options.credentials.password) {
    options.connectionString = [
      'amqps://',         // Ensure that we're using SSL
      options.credentials.username,
      ':',
      options.credentials.password,
      '@',
      options.credentials.hostname || 'pulse.mozilla.org',
      ':',
      5671                // Port for SSL
    ].join('');
    // Also construct exchange prefix
    exchangePrefix = [
      'exchange',
      options.credentials.username,
      options.exchangePrefix
    ].join('/');
  }

  // Clone entries for consistency
  var entries = _.cloneDeep(this._entries);

  // Create connection
  var conn = null;
  var channel = null;
  return amqplib.connect(options.connectionString, {
    // Disable TCP Nagle, test don't show any difference in performance, but
    // it probably can't hurt to disable Nagle, this is a low bandwidth
    // application, so it makes a lot of sense to disable Nagle.
    noDelay:          true
  }).then(function(conn_) {
    conn = conn_;
    return conn.createConfirmChannel();
  }).then(function(channel_) {
    channel = channel_;

    return Promise.all(entries.map(function(entry) {
      var name = exchangePrefix + entry.exchange;
      return channel.assertExchange(name, 'topic', {
        durable:      options.durableExchanges,
        internal:     false,
        autoDelete:   false
      });
    }));
  }).then(function() {
    return new Publisher(conn, channel, entries, exchangePrefix, options);
  });
};

/**
 * Return reference as JSON for the declared exchanges
 *
 * options: {
 *   credentials: {
 *     username:        '...',   // Pulse username
 *   },
 *   exchangePrefix:    '...',   // Exchange prefix, if not credentials
 * }
 */
Exchanges.prototype.reference = function(options) {
  options = _.defaults({}, options || {}, this._options, {
    credentials:        {}
  });

  // Exchange prefix maybe prefixed additionally, if pulse credentials is given
  var exchangePrefix = options.exchangePrefix;

  // If we have a pulse user construct exchange prefix from username
  if (options.credentials.username) {
    // Construct exchange prefix
    exchangePrefix = [
      'exchange',
      options.credentials.username,
      options.exchangePrefix
    ].join('/');
  }

  // Check title and description
  assert(options.title,       "title must be provided");
  assert(options.description, "description must be provided");

  // Create reference
  var reference = {
    version:            0,
    '$schema':          'http://schemas.taskcluster.net/base/v1/' +
                        'exchanges-reference.json#',
    title:              options.title,
    description:        options.description,
    exchangePrefix:     exchangePrefix,
    entries: this._entries.map(function(entry) {
      return {
        type:           'topic-exchange',
        exchange:       entry.exchange,
        name:           entry.name,
        title:          entry.title,
        description:    entry.description,
        routingKey:     entry.routingKey.map(function(key) {
          return _.pick(key, 'name', 'summary', 'constant',
                             'multipleWords', 'required');
        }),
        schema:         entry.schema
      };
    })
  };

  // Create validator to validate schema
  var validator = new Validator();
  // Load exchanges-reference.json schema from disk
  var schemaPath = path.join(__dirname, 'schemas', 'exchanges-reference.json');
  var schema = fs.readFileSync(schemaPath, {encoding: 'utf-8'});
  validator.register(JSON.parse(schema));

  // Check against it
  var refSchema = 'http://schemas.taskcluster.net/base/v1/' +
                  'exchanges-reference.json#';
  var errors = validator.check(reference, refSchema);
  if (errors) {
    debug("Exchanges.references(): Failed to validate against schema, " +
          "errors: %j reference: %j", errors, reference);
    throw new Error("API.references(): Failed to validate against schema");
  }

  // Return reference
  return reference;
};

/**
 * Publish JSON reference for the declared exchanges
 *
 * options:
 * {
 *   credentials: {
 *     username:        '...',                // Pulse username (optional)
 *   },
 *   exchangePrefix:  'queue/v1/'             // Prefix for all exchanges
 *   referencePrefix: 'queue/v1/events.json'  // Prefix within S3 bucket
 *   referenceBucket: 'reference.taskcluster.net',
 *   aws: {             // AWS credentials and region
 *    accessKeyId:      '...',
 *    secretAccessKey:  '...',
 *    region:           'us-west-2'
 *   }
 * }
 *
 * Return a promise that reference was published.
 */
Exchanges.prototype.publish = function(options) {
  // Provide default options
  options = _.defaults({}, options || {}, this._options, {
    referenceBucket:    'references.taskcluster.net'
  });
  // Check that required options are provided
  ['referencePrefix', 'aws'].forEach(function(key) {
    assert(options[key], "Option '" + key + "' must be provided");
  });
  // Create S3 object
  var s3 = new aws.S3(options.aws);
  // Upload object
  return s3.putObject({
    Bucket:           options.referenceBucket,
    Key:              options.referencePrefix,
    Body:             JSON.stringify(this.reference(options), undefined, 2),
    ContentType:      'application/json'
  }).promise();
};

/**
 * Setup exchanges, return promise for a publisher and publish reference if,
 * ordered to do so.
 *
 * options:
 * {
 *   publish:        false // Publish reference during setup
 * }
 *
 * Takes the same options as `publish` and `connect`.
 */
Exchanges.prototype.setup = function(options) {
  var promises = [];
  promises.push(this.connect(options));
  if (options.publish === true) {
    promises.push(this.publish(options));
  }
  return Promise.all(promises).then(function(vals) {
    return vals[0]; // Return publisher
  });
};

// Export the Exchanges class
module.exports = Exchanges;

// Export reference to Publisher
Exchanges.Publisher = Publisher;

