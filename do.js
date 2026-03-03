import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const CF_FALLBACK_IPS = ['proxyip.cmliussss.net:443'];
const encoder = new TextEncoder();

// 每个 WebSocket 连接的状态，存在 DO 的 Map 里
// key: WebSocket 对象, value: { remoteSocket, remoteWriter, remoteReader, isClosed }
const SESSION_TAG_PREFIX = 'session:';

export class TunnelProxy {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // 用 Map 存每个 ws 对应的远端连接状态
    // Hibernation 唤醒后 ws 对象仍然有效，可作为 key
    this.sessions = new Map();
  }

  // ─── 入口：Worker 调用此方法升级 WebSocket ───────────────────────────
  async fetch(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // ✅ 核心改动：用 this.ctx.acceptWebSocket() 替代 server.accept()
    // 空闲时 DO 自动 hibernate，Duration 计费暂停
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // ─── Hibernation 钩子：收到消息时 DO 自动唤醒 ────────────────────────
  async webSocketMessage(ws, message) {
    // 拿到或初始化此连接的 session 状态
    let session = this.sessions.get(ws);
    if (!session) {
      session = {
        remoteSocket: null,
        remoteWriter: null,
        remoteReader: null,
        isClosed: false,
      };
      this.sessions.set(ws, session);
    }

    if (session.isClosed) return;

    try {
      const data = message;

      if (typeof data === 'string') {
        if (data.startsWith('CONNECT:')) {
          // 格式: CONNECT:<host:port>|<firstFrameData>
          const sep = data.indexOf('|', 8);
          if (sep < 0) throw new Error('Invalid CONNECT frame');
          const targetAddr = data.substring(8, sep);
          const firstFrameData = data.substring(sep + 1);
          await this._connectToRemote(ws, session, targetAddr, firstFrameData);

        } else if (data.startsWith('DATA:')) {
          if (session.remoteWriter) {
            await session.remoteWriter.write(encoder.encode(data.substring(5)));
          }

        } else if (data === 'CLOSE') {
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

  // ─── Hibernation 钩子：连接关闭 ──────────────────────────────────────
  async webSocketClose(ws, code, reason, wasClean) {
    const session = this.sessions.get(ws);
    if (session) this._cleanup(ws, session);
  }

  // ─── Hibernation 钩子：连接出错 ──────────────────────────────────────
  async webSocketError(ws, error) {
    const session = this.sessions.get(ws);
    if (session) this._cleanup(ws, session);
  }

  // ─── 内部：连接远端并持续泵数据回 ws ─────────────────────────────────
  async _connectToRemote(ws, session, targetAddr, firstFrameData) {
    const { host: targetHost, port: targetPort } = this._parseAddress(targetAddr);
    if (!targetHost || !targetPort) {
      throw new Error('Invalid CONNECT target, expected host:port');
    }

    const attempts = [null, ...CF_FALLBACK_IPS];

    for (let i = 0; i < attempts.length; i++) {
      try {
        const attempt = attempts[i];
        let hostname, port;

        if (attempt) {
          const parsed = this._parseAddress(attempt, targetPort);
          hostname = parsed.host;
          port = parsed.port;
        } else {
          hostname = targetHost;
          port = targetPort;
        }

        session.remoteSocket = connect({ hostname, port });
        if (session.remoteSocket.opened) await session.remoteSocket.opened;

        session.remoteWriter = session.remoteSocket.writable.getWriter();
        session.remoteReader = session.remoteSocket.readable.getReader();

        if (firstFrameData) {
          await session.remoteWriter.write(encoder.encode(firstFrameData));
        }

        ws.send('CONNECTED');

        // 异步泵：远端数据 → ws
        // 注意：pump 期间 DO 保持活跃（有 I/O），符合预期
        this._pumpRemoteToWebSocket(ws, session);
        return;

      } catch (err) {
        this._releaseRemote(session);

        if (!this._isCFError(err) || i === attempts.length - 1) {
          throw err;
        }
      }
    }
  }

  // ─── 内部：将远端数据转发给 ws ────────────────────────────────────────
  async _pumpRemoteToWebSocket(ws, session) {
    try {
      while (!session.isClosed && session.remoteReader) {
        const { done, value } = await session.remoteReader.read();
        if (done) break;
        if (ws.readyState !== WS_READY_STATE_OPEN) break;
        if (value?.byteLength > 0) ws.send(value);
      }
    } catch {}

    if (!session.isClosed) {
      try { ws.send('CLOSE'); } catch {}
      this._cleanup(ws, session);
    }
  }

  // ─── 内部：清理单个 session ───────────────────────────────────────────
  _cleanup(ws, session) {
    if (session.isClosed) return;
    session.isClosed = true;

    this._releaseRemote(session);
    this.sessions.delete(ws);

    // 关闭 ws（Hibernation 模式下用 ws.close()）
    try {
      if (ws.readyState === WS_READY_STATE_OPEN ||
          ws.readyState === WS_READY_STATE_CLOSING) {
        ws.close(1000, 'Server closed');
      }
    } catch {}
  }

  // ─── 内部：释放远端 socket ────────────────────────────────────────────
  _releaseRemote(session) {
    try { session.remoteWriter?.releaseLock(); } catch {}
    try { session.remoteReader?.releaseLock(); } catch {}
    try { session.remoteSocket?.close(); } catch {}
    session.remoteWriter = null;
    session.remoteReader = null;
    session.remoteSocket = null;
  }

  // ─── 内部：解析 host:port ─────────────────────────────────────────────
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

    const sep = addr.lastIndexOf(':');
    const colonCount = (addr.match(/:/g) || []).length;
    if (colonCount > 1) return { host: addr, port: defaultPort };

    if (sep !== -1) {
      const port = parseInt(addr.substring(sep + 1), 10);
      if (!Number.isNaN(port)) {
        return { host: addr.substring(0, sep), port };
      }
    }

    return { host: addr, port: defaultPort };
  }

  // ─── 内部：判断是否 CF 网络错误（需要 fallback）────────────────────────
  _isCFError(err) {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') ||
           msg.includes('cannot connect') ||
           msg.includes('cloudflare');
  }
}
