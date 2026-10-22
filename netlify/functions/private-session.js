"use strict";

const { createHandler } = require("../lib/vercel-shim");
const sessionHandler = require("../../api/private/session");

module.exports.handler = createHandler(sessionHandler);
