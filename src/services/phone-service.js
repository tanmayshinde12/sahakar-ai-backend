import speech from "@google-cloud/speech";
import textToSpeech from "@google-cloud/text-to-speech";
import crypto from "node:crypto";
import { answerQuestion, clearConversation } from "./ai-service.js";

const speechClient = new speech.SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();
const CHUNK_BYTES = 3200; // 100 ms at 8 kHz, 16-bit mono; valid for Exotel Voicebot.

const rms = (buffer) => {
  let total = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    total += sample * sample;
  }
  return Math.sqrt(total / Math.max(1, buffer.length / 2));
};

const languageCodes = ["mr-IN", "hi-IN", "en-IN"];

async function transcribePcm(pcm, sampleRate) {
  const [result] = await speechClient.recognize({
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: sampleRate,
      languageCode: languageCodes[0],
      alternativeLanguageCodes: languageCodes.slice(1),
      model: "latest_short",
      enableAutomaticPunctuation: true
    },
    audio: { content: pcm.toString("base64") }
  });
  return result.results?.map((item) => item.alternatives?.[0]?.transcript || "").join(" ").trim() || "";
}

function stripWavHeader(audio) {
  if (audio.subarray(0, 4).toString() !== "RIFF") return audio;
  const dataOffset = audio.indexOf(Buffer.from("data"));
  return dataOffset >= 0 ? audio.subarray(dataOffset + 8) : audio;
}

async function synthesizePcm(text, languageCode, sampleRate) {
  const [result] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: sampleRate }
  });
  return stripWavHeader(Buffer.from(result.audioContent));
}

const languageToLocale = (language) => ({ mr: "mr-IN", hi: "hi-IN", en: "en-IN" }[language] || "hi-IN");

export class PhoneSession {
  constructor(ws) {
    this.ws = ws;
    this.streamSid = "";
    this.callSid = "";
    this.sampleRate = 8000;
    this.chunks = [];
    this.speechStarted = false;
    this.silenceMs = 0;
    this.processing = false;
    this.sequence = 0;
    this.conversationId = `phone-${crypto.randomUUID()}`;
  }

  start(payload) {
    this.streamSid = payload.stream_sid || payload.start?.stream_sid || "";
    this.callSid = payload.start?.call_sid || this.streamSid;
    this.sampleRate = Number(payload.start?.media_format?.sample_rate || 8000);
    this.say("नमस्कार. मी सहकार ए आय आहे. मी तुम्हाला कशी मदत करू शकतो?", "mr-IN").catch(this.fail.bind(this));
  }

  receiveMedia(payload) {
    if (this.processing) return;
    const pcm = Buffer.from(payload.media?.payload || "", "base64");
    if (!pcm.length) return;
    const frameMs = (pcm.length / 2 / this.sampleRate) * 1000;
    const isSpeech = rms(pcm) > 360;

    if (isSpeech) {
      this.speechStarted = true;
      this.silenceMs = 0;
    } else if (this.speechStarted) {
      this.silenceMs += frameMs;
    }
    if (this.speechStarted) this.chunks.push(pcm);
    if (this.speechStarted && this.silenceMs >= 800 && this.chunks.length) this.processUtterance();
  }

  async processUtterance() {
    if (this.processing) return;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    this.speechStarted = false;
    this.silenceMs = 0;
    this.processing = true;
    try {
      const transcript = await transcribePcm(pcm, this.sampleRate);
      if (!transcript) return;
      const response = await answerQuestion({ message: transcript, conversationId: this.conversationId });
      await this.say(response.answer, languageToLocale(response.language));
    } catch (error) {
      console.error("Phone turn failed:", error?.message || error);
      await this.say("क्षमस्व, मला आत्ता उत्तर देता आले नाही. कृपया पुन्हा सांगा.", "mr-IN");
    } finally {
      this.processing = false;
    }
  }

  async say(text, languageCode) {
    const pcm = await synthesizePcm(text, languageCode, this.sampleRate);
    for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
      const chunk = pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
      // Exotel requires all media payloads to be a multiple of 320 bytes.
      const padded = chunk.length % 320 ? Buffer.concat([chunk, Buffer.alloc(320 - (chunk.length % 320))]) : chunk;
      this.ws.send(JSON.stringify({
        event: "media",
        sequence_number: ++this.sequence,
        stream_sid: this.streamSid,
        media: { chunk: this.sequence, timestamp: String(this.sequence * 100), payload: padded.toString("base64") }
      }));
    }
  }

  stop() {
    clearConversation(this.conversationId);
  }

  fail(error) {
    console.error("Phone greeting failed:", error?.message || error);
  }
}
