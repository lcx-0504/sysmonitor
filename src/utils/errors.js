'use strict';

function incompleteError(message) {
  return Object.assign(new Error(message), { code: 'EINCOMPLETE' });
}

module.exports = { incompleteError };
