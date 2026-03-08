import WebSocket from 'ws';
import { TwilioMediaMessage } from './types';

export class TwilioStream {
  private ws: WebSocket;
  private streamSid: string | null = null;

  callSid: string | null = null;
  onAudioReceived: ((base64Audio: string) => void) | null = null;
  onStart: ((callSid: string) => void) | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;

    ws.on('message', (data) => {
      const msg: TwilioMediaMessage = JSON.parse(data.toString());

      switch (msg.event) {
        case 'connected':
          console.log('[Twilio] Stream connected');
          break;

        case 'start':
          this.streamSid = msg.start!.streamSid;
          this.callSid = msg.start!.callSid;
          console.log(`[Twilio] Stream started: ${this.streamSid}, callSid: ${this.callSid}`);
          this.onStart?.(this.callSid);
          break;

        case 'media':
          if (msg.media?.payload && this.onAudioReceived) {
            this.onAudioReceived(msg.media.payload);
          }
          break;

        case 'stop':
          console.log('[Twilio] Stream stopped');
          break;
      }
    });

    ws.on('close', () => {
      console.log('[Twilio] WebSocket closed');
    });

    ws.on('error', (err) => {
      console.error('[Twilio] WebSocket error:', err);
    });
  }

  sendAudio(base64Audio: string): void {
    if (this.ws.readyState !== WebSocket.OPEN || !this.streamSid) return;

    this.ws.send(JSON.stringify({
      event: 'media',
      streamSid: this.streamSid,
      media: {
        payload: base64Audio,
      },
    }));
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}
