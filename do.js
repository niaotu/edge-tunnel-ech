import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
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

    // 使用 Hibernation API 接受连接，支持空闲不计费
    this.state.acceptWebSocket(server);

    // 可选：初始化 attachment（这里为空对象，后面会动态设置）
    server.serializeAttachment({});

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // ────────────────────────────────
  // Hibernation 事件处理方法
  // ────────────────────────────────

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.isClosed) return;

    try {
      if (typeof message === 'string') {
        if (message.startsWith('CONNECT:')) {
          const sep = message.indexOf('|', 8);
          if (sep < 0) throw new Error('Invalid CONNECT frame');

          const targetAddr = message.substring(8, sep);
          const firstFrameData = message.substring(sep + 1);

          await this.connectToRemote(ws, targetAddr, firstFrameData);
          ws.send('CONNECTED');
        } 
        else if (message.startsWith('DATA:')) {
          if (attachment.remoteWriter) {
            await attachment.remoteWriter.write(encoder.encode(message.substring(5)));
          }
        } 
        else if (message === 'CLOSE') {
          this.cleanup(ws);
        }
      } 
      else if (message instanceof ArrayBuffer && attachment.remoteWriter) {
        await attachment.remoteWriter.write(new Uint8Array(message));
      }
    } catch (err) {
      try { ws.send('ERROR:' + err.message); } catch {}
      this.cleanup(ws);
    }
  }

  async webSocketClose(ws, code, reason) {
    this.cleanup(ws);
  }

  // 可选：如果需要区分错误关闭
  // webSocketError(ws, error) { this.cleanup(ws); }

  // ────────────────────────────────
  // 核心连接逻辑
  // ────────────────────────────────

  async connectToRemote(ws, targetAddr, firstFrameData) {
    const attachment = ws.deserializeAttachment() || {};
    this.cleanup(ws);  // 先清理旧连接（如果存在）

    const { host: targetHost, port: targetPort } = this.parseAddress(targetAddr);
    if (!targetHost || !targetPort) {
      throw new Error('Invalid CONNECT target, expected host:port');
    }

    const attempts = [null, ...CF_FALLBACK_IPS];

    for (const attempt of attempts) {
      let hostname = targetHost;
      let port = targetPort;

      if (attempt) {
        const parsed = this.parseAddress(attempt, targetPort);
        hostname = parsed.host;
        port = parsed.port;
      }

      try {
        const remoteSocket = connect({ hostname, port });
        await remoteSocket.opened;  // 等待连接建立

        const remoteWriter = remoteSocket.writable.getWriter();
        const remoteReader = remoteSocket.readable.getReader();

        if (firstFrameData) {
          await remoteWriter.write(encoder.encode(firstFrameData));
        }

        // 保存到 attachment
        ws.serializeAttachment({
          ...attachment,
          remoteSocket,
          remoteWriter,
          remoteReader,
          isClosed: false
        });

        this.pumpRemoteToWebSocket(ws);
        return;
      } catch (err) {
        if (!this.isCFError(err) || attempt === CF_FALLBACK_IPS.at(-1)) {
          throw err;
        }
        // 清理本次失败的资源
        // (writer/reader/close 在下次 cleanup 或下个循环处理)
      }
    }
  }

  async pumpRemoteToWebSocket(ws) {
    const { remoteReader } = ws.deserializeAttachment() || {};
    if (!remoteReader) return;

    try {
      while (true) {
        const { done, value } = await remoteReader.read();
        if (done) break;

        const att = ws.deserializeAttachment();
        if (att.isClosed || ws.readyState !== WS_READY_STATE_OPEN) break;

        if (value?.byteLength > 0) {
          ws.send(value);
        }
      }
    } catch {}

    ws.send('CLOSE');
    this.cleanup(ws);
  }

  // ────────────────────────────────
  // 工具方法
  // ────────────────────────────────

  cleanup(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.isClosed) return;

    attachment.isClosed = true;
    ws.serializeAttachment(attachment);

    try { attachment.remoteWriter?.releaseLock(); } catch {}
    try { attachment.remoteReader?.releaseLock(); } catch {}
    try { attachment.remoteSocket?.close(); } catch {}

    // 清空 attachment 中的 socket 引用（可选，但有助于 GC）
    ws.serializeAttachment({ isClosed: true });

    if (ws.readyState === WS_READY_STATE_OPEN || ws.readyState === 2) {
      try { ws.close(1000, 'Server closed'); } catch {}
    }
  }

  parseAddress(addr, defaultPort = null) {
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

  isCFError(err) {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') ||
           msg.includes('cannot connect') ||
           msg.includes('cloudflare');
  }
}
