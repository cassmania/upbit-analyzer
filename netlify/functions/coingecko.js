"use strict";

const { createHandler } = require("../lib/vercel-shim");
const coingeckoHandler = require("../../api/coingecko");

module.exports.handler = createHandler(coingeckoHandler);
