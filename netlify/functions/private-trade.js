"use strict";

const { createHandler } = require("../lib/vercel-shim");
const tradeHandler = require("../../api/private/trade");

module.exports.handler = createHandler(tradeHandler);
