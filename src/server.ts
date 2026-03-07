import 'dotenv/config';
import express from 'express';
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

app.post('/incoming-call', (req, res) => {
  const host = req.headers.host;
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

  // Wire audio: Twilio -> OpenAI
  twilioStream.onAudioReceived = (base64Audio) => {
    openaiSession.sendAudio(base64Audio);
  };

  // Wire audio: OpenAI -> Twilio
  openaiSession.onAudioResponse = (base64Audio) => {
    twilioStream.sendAudio(base64Audio);
  };

  // Clean up on Twilio disconnect
  ws.on('close', () => {
    console.log('[Server] Twilio stream disconnected, closing OpenAI session');
    openaiSession.close();
  });

  try {
    await openaiSession.connect();
    console.log('[Server] Bridge established: Twilio <-> OpenAI');
  } catch (err) {
    console.error('[Server] Failed to connect to OpenAI:', err);
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`Sage server listening on port ${PORT}`);
});
