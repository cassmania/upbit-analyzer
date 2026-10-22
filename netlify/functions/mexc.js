"use strict";

const { createHandler } = require("../lib/vercel-shim");
const mexcHandler = require("../../api/mexc");

module.exports.handler = createHandler(mexcHandler);
