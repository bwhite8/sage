import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { TwilioStream } from './twilio-stream';
import { OpenAIRealtimeSession } from './openai-realtime';
import { DashboardEvent } from './types';

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

function validateTwilioSignature(req: express.Request): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn('[Server] TWILIO_AUTH_TOKEN not set, skipping signature validation');
    return true;
  }

  const signature = req.headers['x-twilio-signature'] as string;
  if (!signature) return false;

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${protocol}://${req.headers.host}${req.originalUrl}`;

  // Build the data string: URL + sorted POST param key-value pairs
  const params = req.body as Record<string, string>;
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + params[key], url);

  const expectedSignature = crypto
    .createHmac('sha1', authToken)
    .update(data)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature),
  );
}

app.post('/incoming-call', (req, res) => {
  if (!validateTwilioSignature(req)) {
    console.warn('[Server] Invalid Twilio signature, rejecting request');
    res.status(403).send('Forbidden');
    return;
  }

  const host = req.headers.host;
  if (!host || !/^[\w.-]+(:\d+)?$/.test(host)) {
    console.warn('[Server] Invalid Host header:', host);
    res.status(400).send('Bad Request');
    return;
  }

  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      <Say voice="alice">Sage is here.</Say>
      <Connect>
        <Stream url="wss://${host}/media-stream" />
      </Connect>
    </Response>
  `.trim());
});

const wss = new WebSocketServer({ noServer: true });
const dashboardWss = new WebSocketServer({ noServer: true });
const dashboardClients = new Set<WebSocket>();

function broadcastDashboard(event: DashboardEvent): void {
  const data = JSON.stringify(event);
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/dashboard') {
    const dashboardToken = process.env.DASHBOARD_TOKEN;
    if (dashboardToken) {
      const token = url.searchParams.get('token');
      if (token !== dashboardToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    dashboardWss.handleUpgrade(request, socket, head, (ws) => {
      dashboardClients.add(ws);
      console.log(`[Dashboard] Client connected (${dashboardClients.size} total)`);
      ws.on('close', () => {
        dashboardClients.delete(ws);
        console.log(`[Dashboard] Client disconnected (${dashboardClients.size} total)`);
      });
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws: WebSocket) => {
  console.log('[Server] New media stream connection');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[Server] OPENAI_API_KEY not set');
    ws.close();
    return;
  }

  const twilioStream = new TwilioStream(ws);
  const openaiSession = new OpenAIRealtimeSession(apiKey);

  // Wire audio: OpenAI -> Twilio (safe to set before connect)
  openaiSession.onAudioResponse = (base64Audio) => {
    twilioStream.sendAudio(base64Audio);
  };

  // Wire dashboard events
  broadcastDashboard({ type: 'call.started' });

  openaiSession.onUserTranscript = (text) => {
    broadcastDashboard({ type: 'transcript.user', text, timestamp: Date.now() });
  };
  openaiSession.onSageTranscriptDelta = (text) => {
    broadcastDashboard({ type: 'transcript.sage.delta', text, timestamp: Date.now() });
  };
  openaiSession.onSageTranscriptDone = (text) => {
    broadcastDashboard({ type: 'transcript.sage', text, timestamp: Date.now() });
  };
  openaiSession.onToolCallStarted = (name, args) => {
    broadcastDashboard({ type: 'tool_call.started', name, args, timestamp: Date.now() });
  };
  openaiSession.onToolCallCompleted = (name, result) => {
    broadcastDashboard({ type: 'tool_call.completed', name, result, timestamp: Date.now() });
  };
  openaiSession.onStatusChange = (status) => {
    broadcastDashboard({ type: 'status', status });
  };

  // Clean up on Twilio disconnect
  ws.on('close', () => {
    console.log('[Server] Twilio stream disconnected, closing OpenAI session');
    broadcastDashboard({ type: 'call.ended' });
    broadcastDashboard({ type: 'status', status: 'idle' });
    openaiSession.close();
  });

  // Clean up on OpenAI disconnect
  openaiSession.onClose = () => {
    console.log('[Server] OpenAI session closed, closing Twilio stream');
    twilioStream.close();
  };

  try {
    await openaiSession.connect();

    // Wire audio: Twilio -> OpenAI (only after OpenAI is connected)
    twilioStream.onAudioReceived = (base64Audio) => {
      openaiSession.sendAudio(base64Audio);
    };

    console.log('[Server] Bridge established: Twilio <-> OpenAI');
  } catch (err) {
    console.error('[Server] Failed to connect to OpenAI:', err);
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`Sage server listening on port ${PORT}`);
});
