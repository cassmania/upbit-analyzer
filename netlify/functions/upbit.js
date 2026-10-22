"use strict";

const { createHandler } = require("../lib/vercel-shim");
const upbitHandler = require("../../api/upbit");

module.exports.handler = createHandler(upbitHandler);
