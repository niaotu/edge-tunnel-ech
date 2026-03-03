import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const CF_FALLBACK_IPS = ['proxyip.cmliussss.net:443'];
const encoder = new TextEncoder();

export class TunnelProxy {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();
    this.handleSession(server).catch(() => this.safeCloseWebSocket(server));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleSession(webSocket) {
    let remoteSocket;
    let remoteWriter;
    let remoteReader;
    let isClosed = false;

    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      try { remoteWriter?.releaseLock(); } catch {}
      try { remoteReader?.releaseLock(); } catch {}
      try { remoteSocket?.close(); } catch {}
      remoteWriter = null;
      remoteReader = null;
      remoteSocket = null;
      this.safeCloseWebSocket(webSocket);
    };

    const pumpRemoteToWebSocket = async () => {
      try {
        while (!isClosed && remoteReader) {
          const { done, value } = await remoteReader.read();
          if (done) break;
          if (webSocket.readyState !== WS_READY_STATE_OPEN) break;
          if (value?.byteLength > 0) webSocket.send(value);
        }
      } catch {}

      if (!isClosed) {
        try { webSocket.send('CLOSE'); } catch {}
        cleanup();
      }
    };

    const parseAddress = (addr, defaultPort = null) => {
      if (addr.startsWith('[')) {
        const end = addr.indexOf(']');
        if (end === -1) return { host: addr, port: defaultPort };

        const host = addr.substring(1, end);
        const portPart = addr.substring(end + 1);

        if (portPart.startsWith(':')) {
          const port = parseInt(portPart.substring(1), 10);
          return { host, port: Number.isNaN(port) ? defaultPort : port };
        }
        return { host, port: defaultPort };
      }

      const sep = addr.lastIndexOf(':');
      const colonCount = (addr.match(/:/g) || []).length;
      if (colonCount > 1) {
        return { host: addr, port: defaultPort };
      }

      if (sep !== -1) {
        const port = parseInt(addr.substring(sep + 1), 10);
        if (!Number.isNaN(port)) {
          return {
            host: addr.substring(0, sep),
            port,
          };
        }
      }

      return { host: addr, port: defaultPort };
    };

    const isCFError = (err) => {
      const msg = err?.message?.toLowerCase() || '';
      return msg.includes('proxy request') ||
             msg.includes('cannot connect') ||
             msg.includes('cloudflare');
    };

    const connectToRemote = async (targetAddr, firstFrameData) => {
      const { host: targetHost, port: targetPort } = parseAddress(targetAddr);
      if (!targetHost || !targetPort) {
        throw new Error('Invalid CONNECT target, expected host:port');
      }

      const attempts = [null, ...CF_FALLBACK_IPS];

      for (let i = 0; i < attempts.length; i++) {
        try {
          const attempt = attempts[i];
          let hostname;
          let port;

          if (attempt) {
            const parsed = parseAddress(attempt, targetPort);
            hostname = parsed.host;
            port = parsed.port;
          } else {
            hostname = targetHost;
            port = targetPort;
          }

          remoteSocket = connect({ hostname, port });
          if (remoteSocket.opened) await remoteSocket.opened;

          remoteWriter = remoteSocket.writable.getWriter();
          remoteReader = remoteSocket.readable.getReader();

          if (firstFrameData) {
            await remoteWriter.write(encoder.encode(firstFrameData));
          }

          webSocket.send('CONNECTED');
          pumpRemoteToWebSocket();
          return;
        } catch (err) {
          try { remoteWriter?.releaseLock(); } catch {}
          try { remoteReader?.releaseLock(); } catch {}
          try { remoteSocket?.close(); } catch {}
          remoteWriter = null;
          remoteReader = null;
          remoteSocket = null;

          if (!isCFError(err) || i === attempts.length - 1) {
            throw err;
          }
        }
      }
    };

    webSocket.addEventListener('message', async (event) => {
      if (isClosed) return;

      try {
        const data = event.data;

        if (typeof data === 'string') {
          if (data.startsWith('CONNECT:')) {
            const sep = data.indexOf('|', 8);
            if (sep < 0) {
              throw new Error('Invalid CONNECT frame');
            }
            await connectToRemote(data.substring(8, sep), data.substring(sep + 1));
          } else if (data.startsWith('DATA:')) {
            if (remoteWriter) {
              await remoteWriter.write(encoder.encode(data.substring(5)));
            }
          } else if (data === 'CLOSE') {
            cleanup();
          }
        } else if (data instanceof ArrayBuffer && remoteWriter) {
          await remoteWriter.write(new Uint8Array(data));
        }
      } catch (err) {
        try { webSocket.send('ERROR:' + err.message); } catch {}
        cleanup();
      }
    });

    webSocket.addEventListener('close', cleanup);
    webSocket.addEventListener('error', cleanup);
  }

  safeCloseWebSocket(ws) {
    try {
      if (ws.readyState === WS_READY_STATE_OPEN || ws.readyState === WS_READY_STATE_CLOSING) {
        ws.close(1000, 'Server closed');
      }
    } catch {}
  }
}
