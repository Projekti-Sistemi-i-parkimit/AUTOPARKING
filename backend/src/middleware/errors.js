"use strict";

// Gabim HTTP me status të përcaktuar — hidhet nga rrugët dhe kapet nga errorHandler.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function notFound(req, res) {
  res.status(404).json({ error: "Rruga nuk u gjet" });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "JSON i pavlefshëm në trupin e kërkesës" });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Gabim i brendshëm i serverit" : err.message });
}

module.exports = { HttpError, notFound, errorHandler };