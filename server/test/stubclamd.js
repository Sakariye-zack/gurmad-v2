// A tiny fake clamd (INSTREAM only) for the test suite. It flags any stream that
// contains the standard EICAR test string, exactly like the real daemon would,
// and answers OK for everything else. Lets us test the upload flow end-to-end
// without installing ClamAV.
const net = require('net');

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function start(port) {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let headerSeen = false;
    const data = [];
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!headerSeen) {
        const nul = buf.indexOf(0);
        if (nul === -1) return;
        headerSeen = true;
        buf = buf.subarray(nul + 1);
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const content = Buffer.concat(data).toString('latin1');
          socket.end(content.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + len) return;
        data.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { start, EICAR };
