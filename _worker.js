const DEFAULT_TOKEN = 'otc';
const CF_FALLBACK_IPS = ['[2a00:1098:2b::1:6815:5881]'];
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const encoder = new TextEncoder();


import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    try {
      const AUTH_TOKEN = env.TOKEN || DEFAULT_TOKEN;
      const upgradeHeader = request.headers.get('Upgrade');

      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new URL(request.url).pathname === '/'
          ? new Response('WebSocket Proxy Server', { status: 200 })
          : new Response('Expected WebSocket', { status: 426 });
      }

      const clientToken = request.headers.get('Sec-WebSocket-Protocol');
      if (AUTH_TOKEN && clientToken !== AUTH_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      server.accept();

      ctx.waitUntil(handleSession(server));

      const responseHeaders = new Headers();
      if (AUTH_TOKEN) {
        responseHeaders.set('Sec-WebSocket-Protocol', AUTH_TOKEN);
      }

      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(err.stack, { status: 500 });
    }
  },
};

async function handleSession(webSocket) {
  let remoteSocket, remoteWriter, remoteReader;
  let isClosed = false;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;

    try { remoteReader?.cancel(); remoteReader?.releaseLock(); } catch {}
    try { remoteWriter?.close(); remoteWriter?.releaseLock(); } catch {}
    try { remoteSocket?.close(); } catch {}

    remoteReader = remoteWriter = remoteSocket = null;
    safeCloseWebSocket(webSocket);
  };

  const pumpRemoteToWebSocket = async () => {
    try {
      while (!isClosed && remoteReader) {
        const { done, value } = await remoteReader.read();
        if (done || isClosed) break;
        if (value?.byteLength > 0 && webSocket.readyState === WS_READY_STATE_OPEN) {
          webSocket.send(value);
        }
      }
    } catch {
    } finally {
      if (!isClosed) {
        try { webSocket.send('CLOSE'); } catch {}
      }
      cleanup();
    }
  };

  const handleMessage = async (data) => {
    if (isClosed) return;

    if (data instanceof ArrayBuffer) {
      if (remoteWriter) await remoteWriter.write(data);
      return;
    }

    if (typeof data === 'string') {
      if (data.startsWith('CONNECT:')) {
        const sepIdx = data.indexOf('|', 8);
        if (sepIdx !== -1) {
          await connectToRemote(data.substring(8, sepIdx), data.substring(sepIdx + 1));
        }
      } else if (data.startsWith('DATA:')) {
        if (remoteWriter) await remoteWriter.write(encoder.encode(data.substring(5)));
      } else if (data === 'CLOSE') {
        cleanup();
      }
    }
  };

  let messageQueue = Promise.resolve();

  webSocket.addEventListener('message', ({ data }) => {
    messageQueue = messageQueue
      .then(() => handleMessage(data))
      .catch(cleanup);
  });

  const isCFError = (err) => {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') ||
           msg.includes('cannot connect') ||
           msg.includes('cloudflare');
  };

  const connectToRemote = async (targetAddr, firstFrameData) => {
    const { host, port } = parseAddress(targetAddr);
    const attempts = [null, ...CF_FALLBACK_IPS];

    for (let i = 0; i < attempts.length; i++) {
      let tempSocket;
      try {
        tempSocket = connect({ hostname: attempts[i] || host, port });
        await tempSocket.opened;

        remoteSocket = tempSocket;
        remoteWriter = remoteSocket.writable.getWriter();
        remoteReader = remoteSocket.readable.getReader();

        if (firstFrameData) {
          await remoteWriter.write(encoder.encode(firstFrameData));
        }

        webSocket.send('CONNECTED');
        pumpRemoteToWebSocket();
        return;
      } catch (err) {
        try { remoteReader?.cancel(); remoteReader?.releaseLock(); } catch {}
        try { remoteWriter?.close(); remoteWriter?.releaseLock(); } catch {}
        try { tempSocket?.close(); } catch {}
        remoteReader = remoteWriter = remoteSocket = null;

        if (!isCFError(err) || i === attempts.length - 1) cleanup();
      }
    }
  };

  webSocket.addEventListener('close', cleanup);
  webSocket.addEventListener('error', cleanup);
}

function parseAddress(addr) {
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    return { host: addr.substring(1, end), port: parseInt(addr.substring(end + 2), 10) };
  }
  const sep = addr.lastIndexOf(':');
  return { host: addr.substring(0, sep), port: parseInt(addr.substring(sep + 1), 10) };
}

function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState < WS_READY_STATE_CLOSING) ws.close(1000, 'Closed');
  } catch {}
}
