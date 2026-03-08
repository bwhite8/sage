export type CallScopedEvent =
  | { type: 'call.started' }
  | { type: 'call.ended' }
  | { type: 'transcript.user'; text: string; timestamp: number }
  | { type: 'transcript.sage'; text: string; timestamp: number }
  | { type: 'transcript.sage.delta'; text: string; timestamp: number }
  | { type: 'tool_call.started'; name: string; args: Record<string, unknown>; timestamp: number }
  | { type: 'tool_call.completed'; name: string; result: string; timestamp: number }
  | { type: 'status'; status: 'idle' | 'listening' | 'thinking' | 'speaking' };

export type DashboardEvent =
  | (CallScopedEvent & { callId: string })
  | { type: 'calls.active'; calls: Array<{ callId: string; startedAt: number }> };

export type DashboardClientMessage =
  | { type: 'get.active_calls' }
  | { type: 'subscribe'; callId: string }
  | { type: 'unsubscribe' };

export interface TwilioMediaMessage {
  event: 'connected' | 'start' | 'media' | 'stop';
  sequenceNumber?: string;
  streamSid?: string;
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;
  };
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
}
