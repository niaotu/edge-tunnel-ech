const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const CF_FALLBACK_IPS = [''];  // 支持端口格式：[IPv6]:端口 或 IP:端口

// 复用 TextEncoder，避免重复创建
const encoder = new TextEncoder();

import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const fallback = url.searchParams.get('fallback');
      const token = 'chinadaja';
      const upgradeHeader = request.headers.get('Upgrade');
      
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new URL(request.url).pathname === '/' 
          ? new Response('', { status: 400 })
          : new Response('Expected WebSocket', { status: 426 });
      }

      if (token && request.headers.get('Sec-WebSocket-Protocol') !== token) {
        return new Response('Unauthorized', { status: 401 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      
      handleSession(server, fallback).catch(() => safeCloseWebSocket(server));

      // 修复 spread 类型错误
      const responseInit = {
        status: 101,
        webSocket: client
      };
      
      if (token) {
        responseInit.headers = { 'Sec-WebSocket-Protocol': token };
      }

      return new Response(null, responseInit);
      
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  },
};

async function handleSession(webSocket, dynamicFallback) {
  let remoteSocket, remoteWriter, remoteReader;
  let isClosed = false;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    
    try { remoteWriter?.releaseLock(); } catch {}
    try { remoteReader?.releaseLock(); } catch {}
    try { remoteSocket?.close(); } catch {}
    
    remoteWriter = remoteReader = remoteSocket = null;
    safeCloseWebSocket(webSocket);
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

  const parseAddress = (addr) => {
    if (addr[0] === '[') {
      const end = addr.indexOf(']');
      return {
        host: addr.substring(1, end),
        port: parseInt(addr.substring(end + 2), 10)
      };
    }
    const sep = addr.lastIndexOf(':');
    return {
      host: addr.substring(0, sep),
      port: parseInt(addr.substring(sep + 1), 10)
    };
  };

  const isCFError = (err) => {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') || 
           msg.includes('cannot connect') || 
           msg.includes('cloudflare');
  };

  const connectToRemote = async (targetAddr, firstFrameData) => {
    const { host, port } = parseAddress(targetAddr);

    // 构建尝试连接的地址列表
    const attempts = [null]; // null 代表原始目标地址

    // 如果有动态传入的 fallback IPs (逗号分隔)
    if (dynamicFallback) {
      const parts = dynamicFallback.split(',').map(s => s.trim()).filter(s => s.length > 0);
      attempts.push(...parts);
    }

    // 最后使用硬编码的 fallback IPs
    attempts.push(...CF_FALLBACK_IPS);

    for (let i = 0; i < attempts.length; i++) {
      try {
        let connectHost, connectPort;
        
        if (attempts[i] === null) {
          connectHost = host;
          connectPort = port;
        } else {
          // 解析 fallback IP 中的主机和端口
          const parsed = parseAddress(attempts[i]);
          connectHost = parsed.host;
          connectPort = parsed.port;
        }
        
        remoteSocket = connect({
          hostname: connectHost,
          port: connectPort
        });

        if (remoteSocket.opened) await remoteSocket.opened;

        remoteWriter = remoteSocket.writable.getWriter();
        remoteReader = remoteSocket.readable.getReader();

        // 发送首帧数据
        if (firstFrameData) {
          await remoteWriter.write(encoder.encode(firstFrameData));
        }

        webSocket.send('CONNECTED');
        pumpRemoteToWebSocket();
        return;

      } catch (err) {
        // 清理失败的连接
        try { remoteWriter?.releaseLock(); } catch {}
        try { remoteReader?.releaseLock(); } catch {}
        try { remoteSocket?.close(); } catch {}
        remoteWriter = remoteReader = remoteSocket = null;

        // 如果不是 CF 错误或已是最后尝试，抛出错误
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
          await connectToRemote(
            data.substring(8, sep),
            data.substring(sep + 1)
          );
        }
        else if (data.startsWith('DATA:')) {
          if (remoteWriter) {
            await remoteWriter.write(encoder.encode(data.substring(5)));
          }
        }
        else if (data === 'CLOSE') {
          cleanup();
        }
      }
      else if (data instanceof ArrayBuffer && remoteWriter) {
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

function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === WS_READY_STATE_OPEN || 
        ws.readyState === WS_READY_STATE_CLOSING) {
      ws.close(1000, 'Server closed');
    }
  } catch {}
}
