// Minimal Electron main to test whether a main-process BrowserWindow can
// render an application/pdf response. Serves a generated PDF over http.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const PDFDocument = require('pdfkit');

const doc = new PDFDocument();
const chunks = [];
doc.on('data', c => chunks.push(c));
doc.on('end', () => {});
doc.text('MartPOS PDF render test'); doc.end();
const pdfBufPromise = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/pdf');
  res.end(await pdfBufPromise);
});

app.whenReady().then(() => {
  server.listen(0, '127.0.0.1', () => {
    const w = new BrowserWindow({ width: 800, height: 600 });
    w.loadURL(`http://127.0.0.1:${server.address().port}/doc.pdf`);
  });
});
