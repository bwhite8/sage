import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { TwilioStream } from './twilio-stream';
import { OpenAIRealtimeSession } from './openai-realtime';
import { CallScopedEvent, DashboardClientMessage } from './types';

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
const dashboardClients = new Map<WebSocket, string | null>();
const activeCalls = new Map<string, { startedAt: number }>();

function broadcastDashboard(callId: string, event: CallScopedEvent): void {
  const data = JSON.stringify({ ...event, callId });
  for (const [client, subscribedCallId] of dashboardClients) {
    if (client.readyState === WebSocket.OPEN && subscribedCallId === callId) {
      client.send(data);
    }
  }
}

function broadcastActiveCallsList(): void {
  const calls = Array.from(activeCalls.entries()).map(([callId, info]) => ({
    callId,
    startedAt: info.startedAt,
  }));
  const data = JSON.stringify({ type: 'calls.active', calls });
  for (const [client, subscribedCallId] of dashboardClients) {
    if (client.readyState === WebSocket.OPEN && subscribedCallId === null) {
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
      dashboardClients.set(ws, null);
      console.log(`[Dashboard] Client connected (${dashboardClients.size} total)`);

      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(String(raw)) as DashboardClientMessage;

          switch (message.type) {
            case 'get.active_calls': {
              const calls = Array.from(activeCalls.entries()).map(([callId, info]) => ({
                callId,
                startedAt: info.startedAt,
              }));
              ws.send(JSON.stringify({ type: 'calls.active', calls }));
              break;
            }
            case 'subscribe': {
              dashboardClients.set(ws, message.callId);
              console.log(`[Dashboard] Client subscribed to call ${message.callId}`);
              // Send call.started so the client knows the call is active
              if (activeCalls.has(message.callId)) {
                ws.send(JSON.stringify({ type: 'call.started', callId: message.callId }));
              }
              break;
            }
            case 'unsubscribe': {
              const prev = dashboardClients.get(ws);
              dashboardClients.set(ws, null);
              console.log(`[Dashboard] Client unsubscribed from call ${prev}`);
              break;
            }
          }
        } catch {
          console.warn('[Dashboard] Failed to parse client message');
        }
      });

      ws.on('close', () => {
        dashboardClients.delete(ws);
        console.log(`[Dashboard] Client disconnected (${dashboardClients.size} total)`);
      });
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws: WebSocket, request: import('http').IncomingMessage) => {
  const wsHost = request.headers.host;
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

  // Wait for Twilio start message to get callSid, then wire dashboard events
  twilioStream.onStart = (callSid) => {
    console.log(`[Server] Call started: ${callSid}`);
    activeCalls.set(callSid, { startedAt: Date.now() });
    broadcastActiveCallsList();

    // Send DTMF *6 to unmute in Teams after a short delay
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (accountSid && authToken) {
      setTimeout(async () => {
        try {
          const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              Twiml: `<Response><Play digits="w*6"/><Connect><Stream url="wss://${wsHost}/media-stream"/></Connect></Response>`,
            }),
          });
          if (resp.ok) {
            console.log(`[Server] Sent DTMF *6 to unmute call ${callSid}`);
          } else {
            console.error(`[Server] Failed to send DTMF: ${resp.status} ${resp.statusText}`);
          }
        } catch (err) {
          console.error('[Server] Error sending DTMF:', err);
        }
      }, 3000);
    }

    broadcastDashboard(callSid, { type: 'call.started' });

    openaiSession.onUserTranscript = (text) => {
      broadcastDashboard(callSid, { type: 'transcript.user', text, timestamp: Date.now() });
    };
    openaiSession.onSageTranscriptDelta = (text) => {
      broadcastDashboard(callSid, { type: 'transcript.sage.delta', text, timestamp: Date.now() });
    };
    openaiSession.onSageTranscriptDone = (text) => {
      broadcastDashboard(callSid, { type: 'transcript.sage', text, timestamp: Date.now() });
    };
    openaiSession.onToolCallStarted = (name, args) => {
      broadcastDashboard(callSid, { type: 'tool_call.started', name, args, timestamp: Date.now() });
    };
    openaiSession.onToolCallCompleted = (name, result) => {
      broadcastDashboard(callSid, { type: 'tool_call.completed', name, result, timestamp: Date.now() });
    };
    openaiSession.onStatusChange = (status) => {
      broadcastDashboard(callSid, { type: 'status', status });
    };
  };

  // Clean up on Twilio disconnect
  ws.on('close', () => {
    const callSid = twilioStream.callSid;
    console.log(`[Server] Twilio stream disconnected (callSid: ${callSid}), closing OpenAI session`);
    if (callSid) {
      broadcastDashboard(callSid, { type: 'call.ended' });
      broadcastDashboard(callSid, { type: 'status', status: 'idle' });
      activeCalls.delete(callSid);
      broadcastActiveCallsList();
    }
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
