import crypto from "node:crypto";

const documents = new Map();
const MAX_TEXT_CHARS = 50000;

export function saveDocument(file) {
  const id = crypto.randomUUID();
  const mimeType = file.mimetype || "application/octet-stream";
  const isText = mimeType === "text/plain" || file.originalname.toLowerCase().endsWith(".txt");
  const document = {
    id,
    name: file.originalname,
    mimeType,
    data: file.buffer.toString("base64"),
    text: isText ? file.buffer.toString("utf8").slice(0, MAX_TEXT_CHARS) : ""
  };
  documents.set(id, document);
  return document;
}

export const getDocument = (id) => documents.get(id);
