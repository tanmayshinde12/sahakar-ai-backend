import { GoogleGenAI } from "@google/genai";
import { config, hasGeminiKey } from "../config.js";

const SYSTEM_INSTRUCTION = `You are Sahakar AI, a multilingual cooperative governance and rural assistance assistant for India.

Reply in the same language used by the caller or user unless they explicitly ask for another language. Support Marathi, Hindi, English and other languages you understand. Explain cooperative laws, government schemes, PACS services, PMFBY, financial literacy and grievance procedures in simple, practical language suitable for rural users. Do not invent laws, scheme eligibility, deadlines, official procedures, or current facts. For legal issues, give informational guidance only, not legal representation. State when the user should verify details with a relevant official authority. Keep answers concise and easy to listen to on a phone call.`;

const conversations = new Map();

export const detectLanguage = (text = "") => {
  if (/\p{Script=Devanagari}/u.test(text)) {
    // Marathi and Hindi share a script; common Marathi particles make a useful UI hint.
    return /(मध्ये|आहे|कसे|काय|मी|मला|करायचा|सहकारी)/u.test(text) ? "mr" : "hi";
  }
  return "en";
};

const contextFor = (conversationId) => (conversations.get(conversationId) || [])
  .slice(-8)
  .map(({ role, text }) => `${role === "user" ? "User" : "Sahakar AI"}: ${text}`)
  .join("\n");

const addTurn = (conversationId, role, text) => {
  const turns = conversations.get(conversationId) || [];
  turns.push({ role, text });
  conversations.set(conversationId, turns.slice(-12));
};

export async function answerQuestion({ message, conversationId, document }) {
  if (!hasGeminiKey()) {
    const error = new Error("AI service is not configured yet. Add GEMINI_API_KEY to backend/.env and restart the server.");
    error.status = 503;
    throw error;
  }

  const priorContext = contextFor(conversationId);
  const prompt = `${priorContext ? `Conversation so far:\n${priorContext}\n\n` : ""}User question: ${message}`;
  const parts = [{ text: prompt }];

  if (document) {
    if (document.text) {
      parts.push({ text: `\n\nUploaded document (${document.name}):\n${document.text}` });
    } else {
      parts.push({ inlineData: { mimeType: document.mimeType, data: document.data } });
      parts.push({ text: `\n\nUse the uploaded document named ${document.name} when answering, and say if it does not contain the requested information.` });
    }
  }

  try {
    const client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    const response = await client.models.generateContent({
      model: config.gemini.model,
      contents: [{ role: "user", parts }],
      config: { systemInstruction: SYSTEM_INSTRUCTION }
    });
    const answer = response.text?.trim();
    if (!answer) throw new Error("The AI service returned an empty response.");

    addTurn(conversationId, "user", message);
    addTurn(conversationId, "assistant", answer);
    return { answer, language: detectLanguage(answer), model: config.gemini.model };
  } catch (cause) {
    console.error("Gemini request failed:", cause?.message || cause);
    const error = new Error("Sahakar AI could not answer right now. Please try again in a moment.");
    error.status = 502;
    throw error;
  }
}

export const clearConversation = (conversationId) => conversations.delete(conversationId);
