"use strict";

const { createHandler } = require("../lib/vercel-shim");
const evidenceHandler = require("../../api/evidence");

module.exports.handler = createHandler(evidenceHandler);
