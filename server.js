const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
require("dotenv").config();

// ─── DB Connect ───────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, {
  tls: true,
  tlsAllowInvalidCertificates: false,
}).then(() => console.log("MongoDB connected")).catch(err => console.error("MongoDB error:", err.message));

// ─── Schemas ──────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId:       { type: String, required: true, unique: true },
  email:          { type: String, required: true },
  name:           String,
  picture:        String,
  telegramChatId: { type: String, default: null },
  linkToken:      { type: String, default: null },
  linkTokenExp:   { type: Date,   default: null },
  createdAt:      { type: Date,   default: Date.now },
});
const User = mongoose.model("User", userSchema);

const chunkSchema = new mongoose.Schema({
  text:      String,
  embedding: [Number],
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
});
const Chunk = mongoose.model("Chunk", chunkSchema);

// ─── Google OAuth Client ──────────────────────────────────────────────────────
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ─── Middleware ───────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

function requireAuth(req, res, next) {
  const token = req.cookies?.authToken;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.clearCookie("authToken");
    return res.status(401).json({ error: "Session expired" });
  }
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.get("/debug-env", (req, res) => {
  res.json({
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    APP_URL: process.env.APP_URL,
  });
});

app.get("/auth/google", (req, res) => {
  const next = req.query.next || "/";
  const url = googleClient.generateAuthUrl({
    access_type: "offline",
    scope: ["profile", "email"],
    state: encodeURIComponent(next),
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const { tokens } = await googleClient.getToken(code);
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { sub, email, name, picture } = ticket.getPayload();

    let user = await User.findOne({ googleId: sub });
    if (!user) {
      user = await User.create({ googleId: sub, email, name, picture });
    }

    const authToken = jwt.sign(
      { _id: user._id, email, name, picture },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.cookie("authToken", authToken, { httpOnly: true, secure: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

    const next = decodeURIComponent(state || "/");
    res.redirect(next);
  } catch (err) {
    console.error("Auth error:", err.message);
    res.redirect("/?error=auth_failed");
  }
});

app.get("/auth/logout", (req, res) => {
  res.clearCookie("authToken");
  res.redirect("/");
});

app.get("/auth/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    name: user.name,
    email: user.email,
    picture: user.picture,
    telegramLinked: !!user.telegramChatId,
  });
});

// ─── Telegram Linking ─────────────────────────────────────────────────────────
app.post("/auth/unlink-telegram", requireAuth, async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { telegramChatId: null });
  res.json({ success: true });
});

app.post("/auth/link-telegram/generate", requireAuth, async (req, res) => {
  const crypto = require("crypto");
  const token = crypto.randomBytes(20).toString("hex");
  const exp = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await User.findByIdAndUpdate(req.user._id, { linkToken: token, linkTokenExp: exp });

  const linkUrl = `${process.env.APP_URL}/link?token=${token}`;
  res.json({ linkUrl });
});

app.get("/link", requireAuth, async (req, res) => {
  const { token, chatId } = req.query;

  const user = await User.findOne({ linkToken: token, linkTokenExp: { $gt: new Date() } });
  if (!user) return res.send("Link expired or invalid. Please generate a new one.");

  // The chatId is embedded in the token URL sent by the bot
  if (chatId) {
    await User.findByIdAndUpdate(req.user._id, {
      telegramChatId: chatId,
      linkToken: null,
      linkTokenExp: null,
    });
    return res.send("Telegram linked successfully! You can now ask questions via your bot.");
  }

  res.send("Missing chatId. Please use the link sent by the bot.");
});

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  let userText = "";
  let userLanguage = "english";

  // Handle /link command
  if (message.text && message.text.startsWith("/link")) {
    const user = await User.findOne({ telegramChatId: String(chatId) });
    if (user) {
      await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: "Your Telegram is already linked to " + user.email,
      });
      return res.sendStatus(200);
    }
    const linkUrl = `${process.env.APP_URL}/auth/google?next=${encodeURIComponent(`/link-telegram?chatId=${chatId}`)}`;
    await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `Click this link to connect your Google account:\n${linkUrl}\n\nLink expires in 10 minutes.`,
    });
    return res.sendStatus(200);
  }

  // Text message
  if (message.text) {
    userText = message.text;
    userLanguage = detectLanguage(userText);
  }

  // Voice message
  if (message.voice) {
    try {
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
    } catch (err) {
      console.error("Voice error:", err.message);
    }
  }

  if (!userText) return res.sendStatus(200);

  console.log("User:", userText);

  try {
    // Find linked user
    const user = await User.findOne({ telegramChatId: String(chatId) });
    if (!user) {
      const linkUrl = `${process.env.APP_URL}/auth/google?next=${encodeURIComponent(`/link-telegram?chatId=${chatId}`)}`;
      await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: `Please link your account first by clicking:\n${linkUrl}`,
      });
      return res.sendStatus(200);
    }

    const queryEmbedding = await getEmbedding(userText);
    const topChunks = await searchStore(queryEmbedding, user._id);
    const answer = await generateAnswer(userText, topChunks, userLanguage);

    console.log("Answer:", answer);

    await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: answer,
    });
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: "Sorry, something went wrong. Please try again in a moment.",
    });
  }

  res.sendStatus(200);
});

// ─── Telegram Link Callback (after Google login) ──────────────────────────────
app.get("/link-telegram", requireAuth, async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.send("Missing chatId.");

  await User.findByIdAndUpdate(req.user._id, { telegramChatId: String(chatId) });

  await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text: `Your account (${req.user.email}) is now linked! You can now ask questions about your documents.`,
  });

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>✅ Telegram Linked!</h2>
      <p>Your account <b>${req.user.email}</b> is now connected to Telegram.</p>
      <p>Go back to Telegram and start asking questions!</p>
      <a href="/">Back to Home</a>
    </body></html>
  `);
});

// ─── Core Functions ───────────────────────────────────────────────────────────
function chunkText(text) {
  return text.match(/.{1,500}/gs) || [];
}

function detectLanguage(text) {
  if (/[ក-៿]/.test(text)) return "khmer";
  return "english";
}

let pdfjsCache = null;
async function getPdfjs() {
  if (!pdfjsCache) {
    pdfjsCache = await import("pdfjs-dist");
    pdfjsCache.GlobalWorkerOptions.workerSrc = "";
  }
  return pdfjsCache;
}

async function extractTextFromPDF(buffer) {
  const pdfjsLib = await getPdfjs();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    pages.push(textContent.items.map((item) => item.str).join(" "));
  }
  return pages.join("\n");
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

async function searchStore(queryEmbedding, userId, topK = 3) {
  const store = await Chunk.find({ userId }).lean();
  if (store.length === 0) return [];
  return store
    .map((item) => ({ text: item.text, score: cosineSimilarity(queryEmbedding, item.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

async function generateAnswer(question, chunks, language = "english") {
  const safeChunks = Array.isArray(chunks) ? chunks : [];
  if (safeChunks.length === 0) {
    return "No document has been uploaded yet. Please upload a PDF from the web app first.";
  }
  const context = safeChunks.map((c) => c.text).join("\n\n");
  const prompt = `Use the context below to answer the question. Reply in ${language}.\n\nContext:\n${context}\n\nQuestion: ${question}`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }] },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
  );
  return response.data.choices[0].message.content;
}

let embedder = null;

async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import("@xenova/transformers");
    embedder = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
  }
  return embedder;
}

async function getEmbedding(text) {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

// ─── Upload Route (protected) ─────────────────────────────────────────────────
app.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const text = await extractTextFromPDF(req.file.buffer);
    if (!text.trim()) {
      return res.status(400).send("No text could be extracted from this PDF. The file may use unsupported encoding.");
    }
    const chunks = chunkText(text);
    console.log(`Split into ${chunks.length} chunks, generating embeddings...`);

    const store = [];
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await getEmbedding(chunks[i]);
      store.push({ text: chunks[i], embedding, userId: req.user._id });
      console.log(`Chunk ${i + 1}/${chunks.length} saved`);
    }

    await Chunk.deleteMany({ userId: req.user._id });
    await Chunk.insertMany(store);
    res.send(`Done! Saved ${chunks.length} chunks.`);
  } catch (err) {
    console.error("Upload error:", err.response?.data || err.message);
    res.status(500).send("Failed: " + (err.response?.data?.error?.message || err.message));
  }
});

// ─── Search Route (protected) ─────────────────────────────────────────────────
app.get("/search", requireAuth, async (req, res) => {
  const question = req.query.q;
  const queryEmbedding = await getEmbedding(question);
  const topChunks = await searchStore(queryEmbedding, req.user._id);
  const answer = await generateAnswer(question, topChunks);
  res.json({ answer, topChunks });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
