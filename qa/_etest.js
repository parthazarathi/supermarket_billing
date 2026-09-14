const e = require('electron');
console.log('type:', typeof e, 'keys:', Object.keys(e).slice(0,10), 'app:', typeof e.app);
console.log('versions:', JSON.stringify(process.versions.electron), 'type field:', process.env.npm_package_type);
