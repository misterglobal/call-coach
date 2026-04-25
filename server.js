require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { DeepgramClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
// Token validation (Placeholder for Supabase function call later)
async function validateToken(token) {
  if (!token) return false;
  // TODO: Add fetch call to Supabase edge function here
  // For now, any non-empty token is valid
  return token.length > 0;
}

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Socket.IO Authentication Middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (await validateToken(token)) {
    next();
  } else {
    console.log('Socket.IO connection rejected: Invalid token');
    next(new Error('Authentication error: Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log('Socket.IO client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Socket.IO client disconnected:', socket.id);
  });
});

// Deepgram client
const deepgramClient = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory store for each call (mapped by stream ID)
const callTranscripts = new Map(); // streamSid -> [{speaker, text}]

// Serve dashboard (React build) – for development just show a placeholder
app.use(express.static('public')); // will put dashboard build here

// WebSocket server for both Twilio Media Streams and browser microphone
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/browser-stream' || url.pathname === '/call-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

wss.on('connection', async (ws, req) => {
  console.log(`WebSocket connection attempt: ${req.url}`);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (url.pathname === '/browser-stream') {
    if (!(await validateToken(token))) {
      console.log('WebSocket connection rejected: Invalid token');
      ws.close(4001, 'Invalid token');
      return;
    }
    console.log('Browser mic stream connected');

    let streamSid = 'browser-' + Date.now();
    let transcriptArray = [];

    try {
      console.log('Initializing Deepgram connection (direct WebSocket)...');

      const dgUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&diarize=true&encoding=linear16&sample_rate=16000&channels=1';
      const deepgramWs = new WebSocket(dgUrl, {
        headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}` }
      });

      let deepgramReady = false;

      deepgramWs.on('open', () => {
        console.log('Deepgram WebSocket OPEN');
        deepgramReady = true;
      });

      deepgramWs.on('error', (err) => {
        console.error('Deepgram WebSocket error:', err.message);
      });

      deepgramWs.on('close', (code, reason) => {
        console.log(`Deepgram WebSocket closed: ${code} ${reason}`);
        deepgramReady = false;
      });

      callTranscripts.set(streamSid, []);

      deepgramWs.on('message', (raw) => {
        try {
          const json = JSON.parse(raw);
          if (json.type !== 'Results') return;
          if (!json.channel?.alternatives?.[0]) return;
          const transcript = json.channel.alternatives[0].transcript;
          const words = json.channel.alternatives[0].words || [];

          if (transcript && transcript.trim()) {
            console.log(`[Deepgram Result] ${streamSid}: ${transcript}`);
            // Determine speaker with diarization
            const speakerCounts = {};
            words.forEach(w => {
              const spk = w.speaker !== undefined ? `speaker_${w.speaker}` : 'unknown';
              speakerCounts[spk] = (speakerCounts[spk] || 0) + 1;
            });
            let dominantSpeaker = Object.keys(speakerCounts).sort((a, b) => speakerCounts[b] - speakerCounts[a])[0];
            let speakerLabel = dominantSpeaker === 'speaker_0' ? 'prospect' : 'you';

            console.log(`[${streamSid}] ${speakerLabel}: ${transcript}`);
            transcriptArray = callTranscripts.get(streamSid) || [];
            transcriptArray.push({ speaker: speakerLabel, text: transcript });
            callTranscripts.set(streamSid, transcriptArray);
          }
        } catch (e) {
          console.error('Error parsing Deepgram message:', e.message);
        }
      });

      ws.on('message', (data) => {
        if (deepgramReady) {
          deepgramWs.send(data);
        }
      });

      ws.on('close', () => {
        console.log('Browser WebSocket closed, cleaning up...');
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.close();
        }
        callTranscripts.delete(streamSid);
      });
    } catch (err) {
      console.error('Failed to initialize browser Deepgram:', err.message);
      console.error('Full error:', err);
      ws.close(1011, 'Deepgram initialization failed');
      return;
    }
    return;
  }

  // Existing Twilio /call-stream handler
  if (url.pathname === '/call-stream') {
    console.log('Twilio stream connected');
    let streamSid = null;
    let deepgramLive = null;
    let transcriptArray = []; // [{speaker, text}]

    // Detect speaker: Twilio sends track "inbound" vs "outbound"
    const getSpeaker = (track) => (track === 'inbound' ? 'prospect' : 'you');

    // Initialize Deepgram live transcription
    try {
      const dgUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&interim_results=false&encoding=mulaw&sample_rate=8000&channels=1';
      deepgramLive = new WebSocket(dgUrl, {
        headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}` }
      });

      deepgramLive.on('open', () => {
        console.log('Deepgram Twilio WebSocket OPEN');
      });

      deepgramLive.on('error', (err) => {
        console.error('Deepgram Twilio WebSocket error:', err.message);
      });

      // When Deepgram sends a final transcript
      deepgramLive.on('message', (raw) => {
        const data = JSON.parse(raw);
        if (data.type !== 'Results') return;
        if (!data.channel?.alternatives?.[0]) return;
        const words = data.channel.alternatives[0].words || [];
        if (!words || words.length === 0) return;
        // Get speaker from the first word (track assumed constant for this utterance)
        const speaker = getSpeaker(words[0].track || 'inbound');
        const text = data.channel.alternatives[0].transcript;
        if (text?.trim()) {
          console.log(`[Twilio ${streamSid}] ${speaker}: ${text}`);
          transcriptArray.push({ speaker, text });
          // Store in callTranscripts map for potential access
          callTranscripts.set(streamSid, transcriptArray);
          // Trigger coaching after a new customer line? Just schedule it periodically
        }
      });
    } catch (err) {
      console.error('Failed to initialize Twilio Deepgram:', err.message);
      console.error('Full error:', err);
      ws.close(1011, 'Deepgram initialization failed');
      return;
    }

    // Twilio media stream message
    ws.on('message', (msg) => {
      const data = JSON.parse(msg);
      switch (data.event) {
        case 'connected':
          // data.streamSid is the unique stream identifier
          streamSid = data.streamSid;
          console.log('Stream started:', streamSid);
          callTranscripts.set(streamSid, []);
          break;

        case 'media':
          // Twilio sends audio as base64 mulaw, we need to send audio to Deepgram
          if (deepgramLive && deepgramLive.readyState === WebSocket.OPEN) {
            // Convert base64 to buffer and send
            const audioBuffer = Buffer.from(data.media.payload, 'base64');
            deepgramLive.send(audioBuffer);
          }
          break;

        case 'stop':
          console.log('Stream stopped by Twilio');
          if (deepgramLive) deepgramLive.close();
          callTranscripts.delete(streamSid);
          break;
      }
    });

    ws.on('close', () => {
      if (deepgramLive) deepgramLive.close();
      callTranscripts.delete(streamSid);
    });
  }
});

// Periodic coaching: every 5 seconds for active calls, send last ~6 lines to GPT
setInterval(async () => {
  for (const [streamSid, transcript] of callTranscripts.entries()) {
    console.log(`[Coaching loop] ${streamSid}: ${transcript.length} utterance(s)`);
    if (transcript.length === 0) continue;
    // Take last 6-8 utterances (roughly the recent context)
    const context = transcript.slice(-6);
    const conversationText = context
      .map(line => `${line.speaker === 'you' ? 'You' : 'Prospect'}: ${line.text}`)
      .join('\n');

    // Call GPT-4o mini with a structured prompt
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `
You are a REAL-TIME sales call coach.

Context:
* The user is on a live phone call selling an AI phone agent for businesses.
* The transcript may be incomplete, noisy, or mid-sentence.
* Prioritize SPEED and PRACTICAL coaching over perfect analysis.
* Give advice that can be used immediately while speaking.

Primary Goal:
Move the conversation toward a booked demo or clear next step.

Rules:
* Be decisive even with imperfect information.
* Never explain theory.
* Never give multiple options.
* Optimize for conversational momentum.
* Assume the prospect cares about revenue, time savings, or missed opportunities.
* Keep coaching psychologically realistic for live speech.

Call Stages (infer automatically):
discovery | objection | qualification | closing | losing_control

Return ONLY a JSON object with ALL string values:
{
"stage": "current inferred call stage",
"concern": "prospect's main concern in one short sentence",
"response_tip": "one tactical phrase describing how to respond",
"next_line": "exact sentence user should say next, under 12 words",
"warning": "why call is at risk OR 'none'",
"talk_ratio": "estimated You/Prospect ratio like 60/40",
"momentum": "improving | neutral | declining"
}

Constraints:
* next_line must sound natural spoken aloud.
* Avoid marketing language.
* Do not mention AI, prompts, or analysis.
* If information is unclear, make the best reasonable inference.
* Output ONLY valid JSON. No explanations.
            `.trim()
          },
          { role: 'user', content: `Conversation:\n${conversationText}` }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' } // requires GPT-4o-mini with JSON mode enabled
      });

      const content = response.choices[0].message.content;
      console.log(`[Coaching Result] ${streamSid}:`, content);
      const coaching = JSON.parse(content);

      // Emit to dashboard via Socket.IO (room per call, or broadcast all)
      io.emit('coaching_update', {
        streamSid,
        ...coaching
      });
      console.log(`[Socket.IO] Emitted coaching_update for ${streamSid}`);
    } catch (err) {
      console.error('Coaching error:', err.message);
      // Optionally emit error
    }
  }
}, 5000);

server.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});