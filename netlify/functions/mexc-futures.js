"use strict";

const { createHandler } = require("../lib/vercel-shim");
const futuresHandler = require("../../api/mexc-futures");

module.exports.handler = createHandler(futuresHandler);
