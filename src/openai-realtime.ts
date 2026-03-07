import WebSocket from 'ws';

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime';

const SYSTEM_PROMPT = `You are Sage, an AI assistant participating in a meeting via phone call. You can hear all participants in the meeting.

CRITICAL BEHAVIOR RULES:
- You MUST only speak when someone directly addresses you by name ("Sage").
- If no one says your name or directs a question at you, remain completely silent. Do not respond. Do not acknowledge.
- When addressed, respond concisely and conversationally. You are a meeting participant, not a lecturer.
- Keep responses brief — this is a live meeting and long responses waste everyone's time.
- If asked to look something up, use the web search tool to find current information.
- When you need to search, briefly say something like "Let me look that up" before searching.
- After getting search results, summarize the key findings conversationally.
- If you're unsure whether someone was talking to you, stay silent. Err on the side of not responding.`;

const WEB_SEARCH_TOOL = {
  type: 'function',
  name: 'web_search',
  description: 'Search the web for current information',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
    },
    required: ['query'],
  },
};

export class OpenAIRealtimeSession {
  private ws: WebSocket | null = null;
  private apiKey: string;

  onAudioResponse: ((base64Audio: string) => void) | null = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(OPENAI_REALTIME_URL, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.ws.on('open', () => {
        console.log('[OpenAI] Connected to Realtime API');
        this.sendSessionUpdate();
        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      });

      this.ws.on('close', () => {
        console.log('[OpenAI] WebSocket closed');
      });

      this.ws.on('error', (err) => {
        console.error('[OpenAI] WebSocket error:', err);
        reject(err);
      });
    });
  }

  private sendSessionUpdate(): void {
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: 'alloy',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions: SYSTEM_PROMPT,
        tools: [WEB_SEARCH_TOOL],
        turn_detection: {
          type: 'server_vad',
        },
      },
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'session.created':
        console.log('[OpenAI] Session created');
        break;

      case 'session.updated':
        console.log('[OpenAI] Session updated');
        break;

      case 'response.audio.delta':
        if (msg.delta && this.onAudioResponse) {
          this.onAudioResponse(msg.delta as string);
        }
        break;

      case 'response.audio.done':
        console.log('[OpenAI] Audio response complete');
        break;

      case 'response.function_call_arguments.done':
        this.handleFunctionCall(msg);
        break;

      case 'error':
        console.error('[OpenAI] Error:', JSON.stringify(msg));
        break;
    }
  }

  private async handleFunctionCall(msg: Record<string, unknown>): Promise<void> {
    const name = msg.name as string;
    const callId = msg.call_id as string;
    const args = JSON.parse(msg.arguments as string);

    console.log(`[OpenAI] Function call: ${name}`, args);

    if (name === 'web_search') {
      try {
        const result = await this.executeWebSearch(args.query);
        this.sendFunctionResult(callId, result);
      } catch (err) {
        console.error('[OpenAI] Web search failed:', err);
        this.sendFunctionResult(callId, 'Sorry, the web search failed. Please try again.');
      }
    } else {
      this.sendFunctionResult(callId, `Unknown function: ${name}`);
    }
  }

  private async executeWebSearch(query: string): Promise<string> {
    console.log(`[OpenAI] Executing web search: "${query}"`);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        tools: [{ type: 'web_search_preview' }],
        messages: [
          {
            role: 'user',
            content: query,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chat Completions API error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string | null } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return content || 'No results found.';
  }

  private sendFunctionResult(callId: string, result: string): void {
    // Send the function output back to the conversation
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: result,
      },
    });

    // Trigger a new response based on the function output
    this.send({
      type: 'response.create',
    });
  }

  sendAudio(base64Audio: string): void {
    this.send({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}
