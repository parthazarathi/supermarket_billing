// Gateway-local invoice PDF renderer. Kept as a separate module so callers
// (queueWorker) keep their existing import path; the implementation lives in
// ./lib/pdfGenerator, which is self-contained - no imports outside gateway/.
module.exports = require('./lib/pdfGenerator');
