// Re-exports the shared lib/pdfGenerator; the gateway always passes a settings
// snapshot so lib/settings (and sql.js) is never loaded here.
module.exports = require('../../lib/pdfGenerator');
