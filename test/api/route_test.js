suite("api/route", function() {
  require('superagent-hawk')(require('superagent'));
  var request         = require('superagent-promise');
  var assert          = require('assert');
  var Promise         = require('promise');
  var mockAuthServer  = require('../mockauthserver');
  var base            = require('../../');
  var express         = require('express');
  var slugid          = require('slugid');

  // Create test api
  var api = new base.API({
    title:        "Test Api",
    description:  "Another test api",
    params: {
      taskId:     /^[a-zA-Z0-9-_]{22}$/
    }
  });

  api.declare({
    method:   'get',
    route:    '/single-param/:myparam',
    name:     'testParam',
    title:    "Test End-Point",
    description:  "Place we can call to test something",
  }, function(req, res) {
    res.status(200).send(req.params.myparam);
  });

  api.declare({
    method:   'get',
    route:    '/slash-param/:name(*)',
    name:     'testSlashParam',
    title:    "Test End-Point",
    description:  "Place we can call to test something",
  }, function(req, res) {
    res.status(200).send(req.params.name);
  });

  api.declare({
    method:   'get',
    route:    '/validated-param/:taskId',
    name:     'testParamValidation',
    title:    "Test End-Point",
    description:  "Place we can call to test something",
  }, function(req, res) {
    res.status(200).send(req.params.taskId);
  });

  api.declare({
    method:   'get',
    route:    '/validated-param-2/:param2',
    name:     'testParam2Validation',
    title:    "Test End-Point",
    description:  "Place we can call to test something",
    params: {
      param2: function(value) {
        if (value !== 'correct') {
          return "Wrong value passed!";
        }
      }
    }
  }, function(req, res) {
    res.status(200).send(req.params.param2);
  });

  // Reference to mock authentication server
  var _mockAuthServer = null;
  // Reference for test api server
  var _apiServer = null;

  // Create a mock authentication server
  setup(function(){
    assert(_mockAuthServer === null,  "_mockAuthServer must be null");
    assert(_apiServer === null,       "_apiServer must be null");
    return mockAuthServer({
      port:         23243
    }).then(function(server) {
      _mockAuthServer = server;
    }).then(function() {
      // Create server for api
      return base.validator().then(function(validator) {

        // Create router
        var router = api.router({
          validator:      validator,
          credentials: {
            clientId:     'test-client',
            accessToken:  'test-token'
          },
          authBaseUrl:    'http://localhost:23243'
        });


        // Create application
        app = express();

        // Use router
        app.use(router);

        return new Promise(function(accept, reject) {
          var server = app.listen(23525);
          server.once('listening', function() {
            accept(server)
          });
          server.once('error', reject);
          _apiServer = server;
        });
      });
    });
  });

  // Close server
  teardown(function() {
    assert(_mockAuthServer, "_mockAuthServer doesn't exist");
    assert(_apiServer,      "_apiServer doesn't exist");
    return new Promise(function(accept) {
      _apiServer.once('close', function() {
        _apiServer = null;
        accept();
      });
      _apiServer.close();
    }).then(function() {
      return new Promise(function(accept) {
        _mockAuthServer.once('close', function() {
          _mockAuthServer = null;
          accept();
        });
        _mockAuthServer.close();
      });
    });
  });

  test("single parameter", function() {
    var url = 'http://localhost:23525/single-param/Hello';
    return request
      .get(url)
      .end()
      .then(function(res) {
        assert(res.ok, "Request failed");
        assert(res.text === "Hello", "Got wrong value");
      });
  });


  test("slash parameter", function() {
    var url = 'http://localhost:23525/slash-param/Hello/World';
    return request
      .get(url)
      .end()
      .then(function(res) {
        assert(res.ok, "Request failed");
        assert(res.text === "Hello/World", "Got wrong value");
      });
  });

  test("validated reg-exp parameter (valid)", function() {
    var id = slugid.v4();
    var url = 'http://localhost:23525/validated-param/' + id;
    return request
      .get(url)
      .end()
      .then(function(res) {
        assert(res.ok, "Request failed");
        assert(res.text === id, "Got wrong value");
      });
  });

  test("validated reg-exp parameter (invalid)", function() {
    var url = 'http://localhost:23525/validated-param/-';
    return request
      .get(url)
      .end()
      .then(function(res) {
        assert(!res.ok, "Expected a failure");
        assert(res.status === 400, "Expected a 400 error");
      });
  });

  test("validated function parameter (valid)", function() {
    var url = 'http://localhost:23525/validated-param-2/correct';
    return request
      .get(url)
      .end()
      .then(function(res) {
        assert(res.ok, "Request failed");
        assert(res.text === 'correct', "Got wrong value");
      });
  });

  test("validated function parameter (invalid)", function() {
    var url = 'http://localhost:23525/validated-param-2/incorrect';
    return request
      .get(url)
      .end()
      .then(function(res) {
        assert(!res.ok, "Expected a failure");
        assert(res.status === 400, "Expected a 400 error");
      });
  });

  test("reference", function() {
    var ref = api.reference({baseUrl: 'http://localhost:23243'});
    ref.entries.forEach(function(entry) {
      if (entry.name == 'testSlashParam') {
        assert(entry.route === "/slash-param/<name>",
               "not parsing route correctly");
        assert(entry.args.length === 1, "Wrong number of args");
        assert(entry.args[0] === 'name', "Failed to parse route correctly");
      }
    });
  });
});
