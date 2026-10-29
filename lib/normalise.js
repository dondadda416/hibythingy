'use strict';
function normalise(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*[\u2014\u2013\-]{1,3}\s*/g, ' \u2014 ')
    .replace(/\s*[\(\[].+?[\)\]]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
module.exports = normalise;
