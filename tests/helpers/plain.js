'use strict';
// Values created inside the sandbox have a different Object/Array prototype from
// the test file's, which makes deepStrictEqual fail even when contents match.
// plain() converts them to ordinary objects first.
module.exports = { plain: v => (v === undefined ? v : JSON.parse(JSON.stringify(v))) };
