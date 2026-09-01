import "dotenv/config";

const required = (name) => process.env[name]?.trim() || "";

export const config = {
  port: Number(process.env.PORT || (process.env.RAILWAY_ENVIRONMENT ? 8080 : 8787)),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  gemini: {
    apiKey: required("GEMINI_API_KEY"),
    model: process.env.GEMINI_MODEL || "gemini-3.7-flash"
  },
  exotel: {
    streamToken: required("EXOTEL_STREAM_TOKEN")
  }
};

export const hasGeminiKey = () => Boolean(config.gemini.apiKey);
