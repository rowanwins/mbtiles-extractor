#!/usr/bin/env node
require = require('esm')(module);
require = require('../src/main').cli(process.argv);
