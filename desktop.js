const http = require('http');
const { spawn } = require('child_process');

function pickPort(preferred = 5055) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const server = net.createServer();

    server.listen(preferred, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });

    server.on('error', () => {
      // If preferred port is taken, let OS pick a random port
      const server2 = net.createServer();
      server2.listen(0, () => {
        const port = server2.address().port;
        server2.close(() => resolve(port));
      });
      server2.on('error', reject);
    });
  });
}

function waitReady(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    
    const check = () => {
      if (Date.now() - start > timeout) {
        reject(new Error('Mart POS server did not start'));
        return;
      }

      http.get(url, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(check, 200);
        }
      }).on('error', () => {
        setTimeout(check, 200);
      });
    };

    check();
  });
}

async function main() {
  try {
    const port = await pickPort(5055);
    const host = '127.0.0.1';
    const url = `http://${host}:${port}/`;

    console.log(`Starting Mart POS on ${url}`);

    // Start the Node.js server
    const serverProcess = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: port.toString() },
      stdio: 'inherit',
      shell: true
    });

    // Wait for server to be ready
    await waitReady(url);
    console.log('Server is ready');

    // Try to open in a browser window
    try {
      const open = require('open');
      await open(url);
      console.log('Browser opened');
    } catch (openError) {
      console.log('Could not open browser automatically');
      console.log(`Please open ${url} in your browser`);
    }

    // Keep the process alive
    serverProcess.on('close', (code) => {
      console.log(`Server process exited with code ${code}`);
      process.exit(code);
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('Shutting down...');
      serverProcess.kill('SIGTERM');
      process.exit(0);
    });

  } catch (error) {
    console.error('Failed to start desktop app:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { pickPort, waitReady, main };
