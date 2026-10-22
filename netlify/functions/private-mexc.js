"use strict";

const { createHandler } = require("../lib/vercel-shim");
const mexcPrivateHandler = require("../../api/private/mexc");

module.exports.handler = createHandler(mexcPrivateHandler);
