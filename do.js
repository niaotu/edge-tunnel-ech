import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const CF_FALLBACK_IPS = ['proxyip.cmliussss.net:443'];
const encoder = new TextEncoder();

export class TunnelProxy {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());

    // ✅ Hibernation API：空闲时 DO 休眠不计费
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // ─── Hibernation 钩子 ─────────────────────────────────────────────────
  async webSocketMessage(ws, message) {
    let session = this.sessions.get(ws);
    if (!session) {
      session = { remoteSocket: null, remoteWriter: null, isClosed: false };
      this.sessions.set(ws, session);
    }
    if (session.isClosed) return;

    try {
      if (typeof message === 'string') {
        if (message.startsWith('CONNECT:')) {
          const sep = message.indexOf('|', 8);
          if (sep < 0) throw new Error('Invalid CONNECT frame');
          await this._connectToRemote(
            ws, session,
            message.substring(8, sep),
            message.substring(sep + 1)
          );
        } else if (message.startsWith('DATA:') && session.remoteWriter) {
          await session.remoteWriter.write(encoder.encode(message.substring(5)));
        } else if (message === 'CLOSE') {
          this._cleanup(ws, session);
        }
      } else if (message instanceof ArrayBuffer && session.remoteWriter) {
        await session.remoteWriter.write(new Uint8Array(message));
      }
    } catch (err) {
      try { ws.send('ERROR:' + err.message); } catch {}
      this._cleanup(ws, session);
    }
  }

  async webSocketClose(ws) {
    const session = this.sessions.get(ws);
    if (session) this._cleanup(ws, session);
  }

  async webSocketError(ws) {
    const session = this.sessions.get(ws);
    if (session) this._cleanup(ws, session);
  }

  // ─── 连接远端 ─────────────────────────────────────────────────────────
  async _connectToRemote(ws, session, targetAddr, firstFrameData) {
    const { host: targetHost, port: targetPort } = this._parseAddress(targetAddr);
    if (!targetHost || !targetPort) throw new Error('Invalid CONNECT target');

    const attempts = [null, ...CF_FALLBACK_IPS];

    for (let i = 0; i < attempts.length; i++) {
      let hostname, port;

      if (attempts[i]) {
        const parsed = this._parseAddress(attempts[i], targetPort);
        hostname = parsed.host;
        port = parsed.port;
      } else {
        hostname = targetHost;
        port = targetPort;
      }

      try {
        const remoteSocket = connect({ hostname, port });
        await remoteSocket.opened;

        session.remoteSocket = remoteSocket;
        session.remoteWriter = remoteSocket.writable.getWriter();

        if (firstFrameData) {
          await session.remoteWriter.write(encoder.encode(firstFrameData));
        }

        ws.send('CONNECTED');

        // ✅ 关键修复：用 pipeTo 替代手动 reader 循环
        // pipeTo 是底层 I/O 操作，DO 休眠不会中断数据流
        remoteSocket.readable.pipeTo(new WritableStream({
          write: (chunk) => {
            if (ws.readyState === WS_READY_STATE_OPEN && chunk?.byteLength > 0) {
              ws.send(chunk);
            }
          },
          close: () => {
            if (!session.isClosed) {
              try { ws.send('CLOSE'); } catch {}
              this._cleanup(ws, session);
            }
          },
          abort: () => this._cleanup(ws, session),
        })).catch(() => this._cleanup(ws, session));

        return;

      } catch (err) {
        try { session.remoteWriter?.releaseLock(); } catch {}
        try { session.remoteSocket?.close(); } catch {}
        session.remoteWriter = null;
        session.remoteSocket = null;

        if (!this._isCFError(err) || i === attempts.length - 1) throw err;
      }
    }
  }

  // ─── 清理 ─────────────────────────────────────────────────────────────
  _cleanup(ws, session) {
    if (session.isClosed) return;
    session.isClosed = true;

    try { session.remoteWriter?.releaseLock(); } catch {}
    try { session.remoteSocket?.close(); } catch {}
    session.remoteWriter = null;
    session.remoteSocket = null;
    this.sessions.delete(ws);

    try {
      if (ws.readyState === WS_READY_STATE_OPEN ||
          ws.readyState === WS_READY_STATE_CLOSING) {
        ws.close(1000, 'Server closed');
      }
    } catch {}
  }

  // ─── 工具函数 ─────────────────────────────────────────────────────────
  _parseAddress(addr, defaultPort = null) {
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
    const colonCount = (addr.match(/:/g) || []).length;
    if (colonCount > 1) return { host: addr, port: defaultPort };
    const sep = addr.lastIndexOf(':');
    if (sep !== -1) {
      const port = parseInt(addr.substring(sep + 1), 10);
      if (!Number.isNaN(port)) return { host: addr.substring(0, sep), port };
    }
    return { host: addr, port: defaultPort };
  }

  _isCFError(err) {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') ||
           msg.includes('cannot connect') ||
           msg.includes('cloudflare');
  }
}
