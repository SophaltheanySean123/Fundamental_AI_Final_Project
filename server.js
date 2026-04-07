const express = require("express");
const axios = require("axios");
const multer = require("multer");
const PDFParser = require("pdf2json");
const FormData = require("form-data");
const mongoose = require("mongoose");
require("dotenv").config();

mongoose.connect(process.env.MONGODB_URI).then(() => console.log("MongoDB connected"));

const chunkSchema = new mongoose.Schema({
  text: String,
  embedding: [Number],
});
const Chunk = mongoose.model("Chunk", chunkSchema);

async function loadStore() {
  return await Chunk.find({}).lean();
}

async function saveStore(data) {
  await Chunk.deleteMany({});
  await Chunk.insertMany(data);
}

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;

  let userText = "";
  let userLanguage = "english";

  // Text message
  if (message.text) {
    userText = message.text;
  }

  // Voice message
  if (message.voice) {
    const fileId = message.voice.file_id;
    const fileInfo = await axios.get(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${fileId}`);
    const filePath = fileInfo.data.result.file_path;
    const voiceRes = await axios.get(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`, { responseType: "arraybuffer" });

    const form = new FormData();
    form.append("file", Buffer.from(voiceRes.data), { filename: "voice.ogg", contentType: "audio/ogg" });
    form.append("model", "whisper-large-v3");
    form.append("response_format", "verbose_json");

    const transcription = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
    );
    userText = transcription.data.text;
    userLanguage = transcription.data.language || "english";
    console.log("Voice transcribed:", userText, "| Language:", userLanguage);
  }

  console.log("User:", userText);

  try {
    const queryEmbedding = await getEmbedding(userText);
    const topChunks = searchStore(queryEmbedding);
    const answer = await generateAnswer(userText, topChunks, userLanguage);

    console.log("Answer:", answer);

    await axios.post(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text: answer }
    );
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    await axios.post(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text: "Sorry, something went wrong. Please try again in a moment." }
    );
  }

  res.sendStatus(200);
});

function chunkText(text) {
  return text.match(/.{1,500}/gs);
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

async function searchStore(queryEmbedding, topK = 3) {
  const store = await loadStore();
  return store
    .map((item) => ({ text: item.text, score: cosineSimilarity(queryEmbedding, item.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

async function generateAnswer(question, chunks, language = "english") {
  const safeChunks = Array.isArray(chunks) ? chunks : [];
  const context = safeChunks.map((c) => c.text).join("\n\n");
  const prompt = `Use the context below to answer the question. Reply in ${language}.\n\nContext:\n${context}\n\nQuestion: ${question}`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
    },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
  );
  return response.data.choices[0].message.content;
}

let embedder = null;

async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import("@xenova/transformers");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return embedder;
}

async function getEmbedding(text) {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

app.get("/search", async (req, res) => {
  const question = req.query.q;
  const queryEmbedding = await getEmbedding(question);
  const topChunks = searchStore(queryEmbedding);
  const answer = await generateAnswer(question, topChunks);
  res.json({ answer, topChunks });
});

app.post("/upload", upload.single("file"), async (req, res) => {
  const parser = new PDFParser();

  parser.on("pdfParser_dataReady", async (pdfData) => {
    try {
      const text = pdfData.Pages.map((page) =>
        page.Texts.map((t) => decodeURIComponent(t.R[0].T)).join(" ")
      ).join("\n");
      const chunks = chunkText(text);
      console.log(`Split into ${chunks.length} chunks, generating embeddings...`);

      const store = [];
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await getEmbedding(chunks[i]);
        store.push({ text: chunks[i], embedding });
        console.log(`Chunk ${i + 1}/${chunks.length} saved`);
      }

      saveStore(store);
      res.send(`Done! Saved ${chunks.length} chunks to store.json`);
    } catch (err) {
      console.error("Embedding error:", err.response?.data || err.message);
      res.status(500).send("Failed: " + (err.response?.data?.error?.message || err.message));
    }
  });

  parser.on("pdfParser_dataError", (err) => {
    console.error(err);
    res.status(500).send("Failed to parse PDF");
  });

  parser.parseBuffer(req.file.buffer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});