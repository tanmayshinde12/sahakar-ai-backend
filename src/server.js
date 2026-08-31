import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import multer from "multer";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { answerQuestion, clearConversation } from "./services/ai-service.js";
import { getDocument, saveDocument } from "./services/document-store.js";
import { PhoneSession } from "./services/phone-service.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    const permitted = ["application/pdf", "text/plain", "image/jpeg", "image/png", "image/webp"];
    callback(permitted.includes(file.mimetype) ? null : new Error("Upload a PDF, TXT, JPG, PNG, or WEBP file."), permitted.includes(file.mimetype));
  }
});

app.use(cors({ origin: config.corsOrigin.split(",").map((item) => item.trim()) }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => response.json({ status: "ok", model: config.gemini.model }));

app.post("/api/chat", async (request, response, next) => {
  try {
    const message = request.body?.message?.trim();
    const conversationId = request.body?.conversation_id?.trim() || crypto.randomUUID();
    const documentId = request.body?.document_id?.trim();
    if (!message) return response.status(400).json({ error: "Please type or speak a question first." });
    const document = documentId ? getDocument(documentId) : undefined;
    if (documentId && !document) return response.status(404).json({ error: "The uploaded document has expired. Please upload it again." });
    const result = await answerQuestion({ message, conversationId, document });
    response.json({ ...result, conversation_id: conversationId });
  } catch (error) { next(error); }
});

app.post("/api/upload", upload.single("document"), (request, response) => {
  if (!request.file) return response.status(400).json({ error: "Choose a PDF, TXT, JPG, PNG, or WEBP document first." });
  const document = saveDocument(request.file);
  response.status(201).json({ document_id: document.id, name: document.name, mime_type: document.mimeType });
});

app.post("/api/conversations/:id/clear", (request, response) => {
  clearConversation(request.params.id);
  response.status(204).end();
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ error: "Please upload a file smaller than 10 MB." });
  const status = error.status || 400;
  response.status(status).json({ error: error.message || "Something went wrong. Please try again." });
});

const server = http.createServer(app);
const websocket = new WebSocketServer({ noServer: true });

websocket.on("connection", (ws) => {
  const session = new PhoneSession(ws);
  ws.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      if (payload.event === "start") session.start(payload);
      if (payload.event === "media") session.receiveMedia(payload);
      if (payload.event === "clear") clearConversation(session.conversationId);
      if (payload.event === "stop") session.stop();
    } catch (error) {
      console.error("Invalid Exotel stream message:", error?.message || error);
    }
  });
  ws.on("close", () => session.stop());
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/api/phone/stream") return socket.destroy();
  const token = url.searchParams.get("token");
  if (config.exotel.streamToken && token !== config.exotel.streamToken) return socket.destroy();
  websocket.handleUpgrade(request, socket, head, (ws) => websocket.emit("connection", ws, request));
});

server.listen(config.port, () => console.log(`Sahakar AI backend listening on http://localhost:${config.port}`));
