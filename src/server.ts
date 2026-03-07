import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { TwilioStream } from './twilio-stream';
import { OpenAIRealtimeSession } from './openai-realtime';

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

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

  if (pathname === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
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

  // Clean up on Twilio disconnect
  ws.on('close', () => {
    console.log('[Server] Twilio stream disconnected, closing OpenAI session');
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
