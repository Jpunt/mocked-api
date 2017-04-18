import express from 'express';
import Path from 'path';
import FS from 'fs';
import JsonPointer from 'json-pointer';
import cors from 'cors';

module.exports = class Server {
  constructor(config) {
    this.reset();

    this.name = config.name;
    this.port = config.port;
    this.dir = config.dir;
    this.cors = config.cors || {};

    this.express = express();
    this.express.use(this.setupCors());
    // JSDOM doesn't implement CORS really well. For instance it expects the Access-Control-Allow-Headers
    // header to be present on the GET instead of the OPTIONS request.
    // This is a workaround to make JSDOM work.
    this.express.get('*', (req, res, next) => {
      if (this.cors.allowedHeaders) {
        res.set('Access-Control-Allow-Headers', this.cors.allowedHeaders.join(','));
      }

      next();
    });
    
    this.express.get('*', (req, res) => {
      this.getHandler(req, res);
    });
    this.express.options('*', (req, res) => {
      this.optionsHandler(req, res);
    });
  }

  reset() {
    this.jsonMutations = [];
    this.statusMutations = [];
    this.respondToPath = null;
    this.responseHandler = () => {};
    return this;
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.server) {
        return resolve();
      }
      this.server = this.express.listen(this.port, () => {
        resolve();
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  setupCors() {
    return cors({ origin: true, credentials: true, ...this.cors });
  }

  getHandler(req, res) {
    const filePath = Path.resolve(this.dir + req.path);

    // Get file and serve it
    this._resolveFilePath(filePath)
      .then(resolvedFilePath => {
        return this._loadJson(resolvedFilePath);
      })
      .then(json => {
        return this._validateJson(json, req, filePath);
      })
      .then(json => {
        return this._mutateJson(json, req);
      })
      .then(mutatedJson => {
        const status = this._getMutatedStatus(req);
        const body = mutatedJson;
        this.responseHandler(status, body);
        res.status(status).json(body);
      })
      .catch((err = []) => {
        this.responseHandler(err[0], err[1]);
        res.status(err[0] || 500).send(err[1] || 'unknown error');
      });
  }

  optionsHandler(req, res) {
    res.set('Access-Control-Allow-Origin', req.get('origin'));
    res.set('Access-Control-Allow-Credentials', true);

    res.sendStatus(204);
  }

  respondTo(path) {
    this.respondToPath = path;
    return this;
  }

  andReplace(pointer, value) {
    this.jsonMutations.push({ path:this.respondToPath, pointer:pointer, value:value });
    return this;
  }

  withStatus(status) {
    this.statusMutations.push({ path:this.respondToPath, status:status });
    return this;
  }

  onResponse(fn) {
    this.responseHandler = fn;
    return this;
  }

  /*
   * Private helpers
   */

  _resolveFilePath(filePath) {
    return new Promise((resolve, reject) => {
      FS.stat(filePath, (err, stats) => {
        err || !stats.isFile() ?
          reject() :
          resolve(filePath);
      });
    }).catch(() => {
      // Fallback to an appended '.json'
      return new Promise((resolve, reject) => {
        FS.stat(filePath + '.json', (err, stats) => {
          err ?
            reject([404, err]) :
            resolve(filePath + '.json');
        });
      });
    });
  }

  _loadJson(filePath) {
    return new Promise((resolve, reject) => {
      FS.readFile(filePath, 'utf8', function(err, data) {
        err ?
          reject([500, err]) :
          resolve(data);
      });
    });
  }

  _validateJson(json, req, filePath) {
    if (!json.trim().startsWith('{')) {
      return Promise.resolve(json);
    }

    try {
      JSON.parse(json);
      return Promise.resolve(json);
    } catch (err) {
      console.log('Could not parse JSON:');
      console.trace(err);
      return Promise.reject([500, {
        message: `File looks like JSON, but could not be parsed (${err.message})`,
        url: req.path,
        file: filePath,
      }]);
    }
  }

  _mutateJson(json, req) {
    const mutated = JSON.parse(json);
    this.jsonMutations.forEach((mutation) => {
      if (req.path == mutation.path) {
        JsonPointer.set(mutated, mutation.pointer, mutation.value);
      }
    });
    return Promise.resolve(mutated);
  }

  _getMutatedStatus(req) {
    const mutationsForPath = this.statusMutations.filter(m => m.path == req.path);
    if (mutationsForPath.length > 0) {
      return mutationsForPath[0].status;
    }
    return 200;
  }
};
