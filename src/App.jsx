import { useState, useEffect, useCallback, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI API HELPER
// ─────────────────────────────────────────────────────────────────────────────
// callGemini — useSearch=true enables Google Search grounding so Gemini
// fetches REAL recent onchain events instead of hallucinating fake scenarios
async function callGemini(apiKey, prompt, systemInstruction = "", useSearch = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    ...(systemInstruction && {
      systemInstruction: { parts: [{ text: systemInstruction }] },
    }),
    generationConfig: { temperature: useSearch ? 0.4 : 0.9, maxOutputTokens: 2048 },
    ...(useSearch && {
      tools: [{ googleSearch: {} }],
    }),
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini API error ${res.status}`);
  }
  const data = await res.json();
  // Extract text from all parts (grounding may split across parts)
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("") || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// ROBUST JSON EXTRACTOR
// Handles: markdown fences, truncated strings, trailing commas, extra text
// ─────────────────────────────────────────────────────────────────────────────
function extractJSON(raw) {
  // 1. Strip markdown code fences
  let text = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

  // 2. Find the outermost { } to isolate JSON
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }

  // 3. Try clean parse first
  try { return JSON.parse(text); } catch (_) {}

  // 4. Auto-repair truncated JSON
  const repaired = repairJSON(text);
  try { return JSON.parse(repaired); } catch (_) {}

  // 5. Field-by-field regex extraction as last resort
  return extractFieldsByRegex(raw);
}

function repairJSON(text) {
  let s = text;

  // Remove trailing commas before ] or }
  s = s.replace(/,\s*([\]}])/g, "$1");

  const opens   = (s.match(/\{/g) || []).length;
  const closes  = (s.match(/\}/g) || []).length;
  const aopens  = (s.match(/\[/g) || []).length;
  const acloses = (s.match(/\]/g) || []).length;

  // Detect mid-string truncation: find last structural character
  const lastStructural = Math.max(s.lastIndexOf(","), s.lastIndexOf("{"), s.lastIndexOf("["));
  if (lastStructural !== -1) {
    const after = s.slice(lastStructural + 1);
    const quoteCount = (after.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      // We are mid-string — chop to last safe position
      s = s.slice(0, lastStructural).replace(/,\s*$/, "");
    }
  }

  // Close open arrays then objects
  for (let i = 0; i < aopens - (s.match(/\]/g) || []).length; i++) s += "]";
  for (let i = 0; i < opens - (s.match(/\}/g) || []).length; i++) s += "}";

  return s;
}

function extractFieldsByRegex(text) {
  const str = (field) => {
    const m = text.match(new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
    return m ? m[1] : "";
  };
  const arr = (field) => {
    const m = text.match(new RegExp('"' + field + '"\\s*:\\s*\\[(.*?)\\]', "s"));
    if (!m) return [];
    return (m[1].match(/"((?:[^"\\\\]|\\\\.)*)"/g) || []).map(s => s.slice(1, -1));
  };
  return {
    title:         str("title")         || "Daily Onchain Challenge",
    realEvent:     str("realEvent")     || "",
    source:        str("source")        || "",
    problem:       str("problem")       || "Could not parse challenge. Try regenerating.",
    hints:         arr("hints"),
    keyMetrics:    arr("keyMetrics"),
    tools:         arr("tools"),
    teachingPoint: str("teachingPoint") || "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-02-25"
}

function getDayNumber() {
  const start = new Date("2025-01-01");
  return Math.floor((Date.now() - start) / 86400000) + 1;
}

const CATEGORIES = [
  { id: "btc",   label: "BTC Fundamentals", emoji: "₿",  color: "#f7931a" },
  { id: "eth",   label: "ETH Fundamentals", emoji: "Ξ",  color: "#627eea" },
  { id: "whale", label: "Whale Tracking",   emoji: "🐋", color: "#0ea5e9" },
  { id: "defi",  label: "DeFi Analytics",   emoji: "🏦", color: "#00c9a7" },
  { id: "nft",   label: "NFT Markets",      emoji: "🖼", color: "#a855f7" },
  { id: "l2",    label: "L2 & Mempool",     emoji: "⚡", color: "#f59e0b" },
  { id: "macro", label: "Cross-Chain Macro",emoji: "🌐", color: "#ef4444" },
];

const DIFFICULTIES = ["Beginner", "Intermediate", "Advanced"];
const DIFF_COLORS   = { Beginner: "#00c9a7", Intermediate: "#f59e0b", Advanced: "#ef4444" };

// Deterministically pick today's category + difficulty so everyone gets same type
function getTodayMeta(offsetDays = 0) {
  const day = getDayNumber() + offsetDays;
  const cat  = CATEGORIES[day % CATEGORIES.length];
  const diff = DIFFICULTIES[Math.floor(day / CATEGORIES.length) % DIFFICULTIES.length];
  return { cat, diff, day };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

// SEARCH QUERY: tells Gemini what real event to find first
function buildSearchQuery(cat, diff) {
  const queries = {
    btc:   `Bitcoin onchain analysis ${todayKey().slice(0,7)} miner exchange flows SOPR MVRV realized price whale accumulation`,
    eth:   `Ethereum onchain data ${todayKey().slice(0,7)} staking withdrawals burn rate validator queue ETH flows`,
    whale: `crypto whale wallet large transaction onchain ${todayKey().slice(0,7)} Bitcoin Ethereum accumulation exchange deposit`,
    defi:  `DeFi protocol onchain event ${todayKey().slice(0,7)} TVL liquidation Aave Uniswap Curve exploit yield`,
    nft:   `NFT onchain data ${todayKey().slice(0,7)} wash trading floor price manipulation collection volume`,
    l2:    `Ethereum L2 onchain ${todayKey().slice(0,7)} Arbitrum Optimism bridge MEV sequencer rollup activity`,
    macro: `crypto stablecoin onchain macro ${todayKey().slice(0,7)} USDT USDC flows depeg market structure`,
  };
  return queries[cat.id] || `crypto onchain analysis event ${todayKey().slice(0,7)}`;
}

// PHASE 1 prompt: search for a real event (uses Google Search grounding)
function buildSearchPrompt(cat, diff, day) {
  return `Search the web right now for a REAL, VERIFIABLE onchain event that happened recently (last 30-60 days) related to: ${cat.label}.

Search for: ${buildSearchQuery(cat, diff)}

Find ONE specific real event with:
- Actual transaction hashes, wallet addresses, or protocol names
- Real numbers (specific dollar amounts, percentages, token quantities)
- A date it happened
- A source (Glassnode, Nansen, Arkham, DeFiLlama, CryptoQuant, news article, etc.)

Then format it as a practice challenge for Day ${day} (difficulty: ${diff}) in this EXACT JSON shape — no markdown, no backticks, just raw JSON:
{
  "title": "Short punchy title based on the real event (5-8 words)",
  "realEvent": "One sentence: what actually happened, when, and where it was reported",
  "source": "URL or source name where this can be verified",
  "problem": "2-3 sentences describing the real onchain data as a puzzle. Include the actual numbers. End with one question: what does this signal?",
  "hints": ["hint using real metric names", "hint about what to look up", "hint about the pattern"],
  "keyMetrics": ["Exact metric name 1", "Exact metric name 2", "Exact metric name 3", "Exact metric name 4"],
  "tools": ["Tool where you can verify this data", "Tool 2", "Tool 3"],
  "teachingPoint": "One sentence: what onchain concept this real event teaches"
}

CRITICAL RULES:
- The event MUST be real and verifiable — do not invent or hallucinate data
- If you cannot find a real recent event for this exact category, find the closest real onchain event from any category in the last 60 days
- Include the actual source URL or publication name so the user can go verify it
- Difficulty ${diff} framing: ${diff === "Beginner" ? "present the data clearly, ask what the basic signal means" : diff === "Intermediate" ? "ask the user to connect 2-3 onchain signals to form a thesis" : "ask the user to reason through multi-step implications and edge cases"}`;
}

function getCategoryAngles(id) {
  const map = {
    btc:   "HODL waves, UTXO age bands, exchange reserves, miner behavior, SOPR, realized price, MVRV",
    eth:   "staking flows, validator queue, EIP-1559 burn, blob fees, LST dominance, restaking risks",
    whale: "wallet clustering, exchange inflows/outflows, OTC desk signals, accumulation patterns, insider timing",
    defi:  "TVL flows, liquidation cascades, yield farming incentives, protocol revenue, ve-token governance, bad debt",
    nft:   "wash trading patterns, floor price manipulation, royalty evasion, collection lifecycle, blue-chip divergence",
    l2:    "bridge flows, MEV extraction, sequencer centralization, gas arbitrage, rollup proof delays",
    macro: "stablecoin dominance, BTC correlation with TradFi, regulatory flow impact, stablecoin depegs, cross-chain contagion",
  };
  return map[id] || "general onchain patterns";
}

function buildFeedbackPrompt(challenge, analysis, conclusion) {
  return `Challenge: "${challenge.title}"
Problem: ${challenge.problem}
Teaching point: ${challenge.teachingPoint}

Student's analysis: ${analysis}
Student's conclusion: ${conclusion}

Evaluate this onchain analysis. Be direct and specific. Format your response in exactly 3 sections using these headers:

✅ WHAT YOU NAILED
(2-3 specific things they got right, reference exact points from their analysis)

🔧 SHARPEN THIS
(1-2 specific gaps, missed metrics, or wrong assumptions — be rigorous)

💡 CORE TAKEAWAY
(One memorable sentence they should never forget about this type of onchain signal)

Keep total response under 220 words. Use onchain analyst language. Don't be generic.`;
}

function buildThreadPrompt(challenge, analysis, conclusion, dayNum) {
  return `You're writing a viral crypto Twitter thread for Day ${dayNum} of someone's daily onchain analysis practice.

Challenge: "${challenge.title}" (${challenge.category} · ${challenge.difficulty})
Problem studied: ${challenge.problem}
Their analysis: ${analysis}
Their conclusion: ${conclusion}

Write a 5-tweet thread that:
Tweet 1 — Hook: the puzzle with the most shocking/interesting number. Start with "🔍 Day ${dayNum} | Onchain puzzle:"
Tweet 2 — The data: bullet points with the key onchain metrics from the problem  
Tweet 3 — The analysis: what the data actually means (use their analysis, make it crisp)
Tweet 4 — The conclusion + actionable insight
Tweet 5 — End with a thought-provoking question for followers + 3-4 relevant hashtags (always include #OnchainAnalysis)

Rules:
- Each tweet MUST be under 270 characters (strict limit)
- Use their actual analysis and numbers — this should feel authentic, not templated
- No hype language, pure data-driven insight
- Make it educational AND engaging — imagine 10k followers reading this

Separate each tweet with exactly: ---TWEET---
Return ONLY the tweets, nothing else.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function loadChallenge(dateKey) {
  try {
    const raw = localStorage.getItem(`od_challenge_${dateKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveChallenge(dateKey, data) {
  try { localStorage.setItem(`od_challenge_${dateKey}`, JSON.stringify(data)); } catch {}
}

function loadApiKey() {
  try { return localStorage.getItem("od_gemini_key") || ""; } catch { return ""; }
}

function saveApiKey(k) {
  try { localStorage.setItem("od_gemini_key", k); } catch {}
}

function loadStreak() {
  try {
    return {
      count: parseInt(localStorage.getItem("od_streak") || "0"),
      last:  localStorage.getItem("od_streak_date") || "",
    };
  } catch { return { count: 0, last: "" }; }
}

function bumpStreak() {
  try {
    const today = todayKey();
    const { count, last } = loadStreak();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    const newCount = last === yesterday ? count + 1 : last === today ? count : 1;
    localStorage.setItem("od_streak", newCount);
    localStorage.setItem("od_streak_date", today);
    return newCount;
  } catch { return 0; }
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem("od_history") || "[]"); } catch { return []; }
}

function pushHistory(entry) {
  try {
    const hist = loadHistory();
    const deduped = hist.filter(h => h.date !== entry.date);
    const next = [entry, ...deduped].slice(0, 60);
    localStorage.setItem("od_history", JSON.stringify(next));
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function Cursor() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn(v => !v), 530);
    return () => clearInterval(t);
  }, []);
  return <span style={{ opacity: on ? 1 : 0, color: "#00c9a7" }}>█</span>;
}

function ProgressBar({ value, max = 280 }) {
  const pct = Math.min(100, (value / max) * 100);
  const color = value > max ? "#ef4444" : value > max * 0.85 ? "#f59e0b" : "#00c9a7";
  return (
    <div>
      <div style={{ background: "#0d1a0d", height: 2, borderRadius: 1 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 1, transition: "width 0.2s" }} />
      </div>
      <div style={{ fontSize: 8, color: value > max ? "#ef4444" : "#1a4a1a", textAlign: "right", marginTop: 3 }}>
        {value}/{max}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function OnchainDojo() {

  // ── API KEY GATE ──
  const [apiKey, setApiKey]         = useState(loadApiKey);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [testingKey, setTestingKey]  = useState(false);

  // ── CHALLENGE STATE ──
  const [challenge, setChallenge]     = useState(null);
  const [generating, setGenerating]   = useState(false);
  const [genError, setGenError]       = useState("");
  const [offsetDays, setOffsetDays]   = useState(0);

  // ── UI STATE ──
  const [phase, setPhase]             = useState("challenge");
  const [hintsOpen, setHintsOpen]     = useState(false);
  const [analysis, setAnalysis]       = useState("");
  const [conclusion, setConclusion]   = useState("");
  const [feedback, setFeedback]       = useState(null);
  const [loadingFeedback, setLoadingFeedback] = useState(false);
  const [thread, setThread]           = useState(null);
  const [loadingThread, setLoadingThread]     = useState(false);
  const [copied, setCopied]           = useState(null);
  const [streak, setStreak]           = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory]         = useState([]);
  const [toast, setToast]             = useState(null);
  const toastRef = useRef(null);

  // ── LOAD STREAK + HISTORY ──
  useEffect(() => {
    setStreak(loadStreak().count);
    setHistory(loadHistory());
  }, []);

  // ── SHOW TOAST ──
  const showToast = useCallback((msg, color = "#00c9a7") => {
    setToast({ msg, color });
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 3500);
  }, []);

  // ── LOAD / GENERATE CHALLENGE ──
  const loadOrGenerateChallenge = useCallback(async (offset, key, forceNew = false) => {
    const { cat, diff, day } = getTodayMeta(offset);
    const dateKey = offset === 0 ? todayKey() : `offset_${getDayNumber() + offset}`;

    // Use cache unless forceNew — regenerate clears cache first
    if (!forceNew) {
      const cached = loadChallenge(dateKey);
      if (cached) {
        setChallenge({ ...cached, cat, diff, day });
        return;
      }
    } else {
      // Clear old cached challenge so a fresh one is saved
      try { localStorage.removeItem(`od_challenge_${dateKey}`); } catch {}
    }

    setGenerating(true);
    setGenError("");
    setChallenge(null);

    try {
      // Use Google Search grounding so Gemini finds REAL recent onchain events
      const raw = await callGemini(key, buildSearchPrompt(cat, diff, day), "", true);
      // Robust extraction — handles truncated/malformed JSON from Gemini
      const parsed = extractJSON(raw);
      if (!parsed.title || !parsed.problem) {
        throw new Error("Gemini returned incomplete data. Tap Regenerate to try again.");
      }
      const full = { ...parsed, category: cat.label, cat, diff, day, dateKey };
      saveChallenge(dateKey, full);
      setChallenge(full);
      if (forceNew) showToast("✨ New challenge generated!");
    } catch (e) {
      setGenError(e.message || "Failed to generate challenge. Check your API key.");
    } finally {
      setGenerating(false);
    }
  }, [showToast]);

  // ── WHEN API KEY SET, LOAD CHALLENGE ──
  useEffect(() => {
    if (apiKey) loadOrGenerateChallenge(offsetDays, apiKey);
  }, [apiKey, offsetDays, loadOrGenerateChallenge]);

  // ── TEST + SAVE API KEY ──
  const handleSaveKey = async () => {
    const k = apiKeyInput.trim();
    if (!k.startsWith("AI")) {
      setApiKeyError("Key should start with 'AI...' — check your Gemini API key.");
      return;
    }
    setTestingKey(true);
    setApiKeyError("");
    try {
      await callGemini(k, "Reply with only the word: OK");
      saveApiKey(k);
      setApiKey(k);
    } catch (e) {
      setApiKeyError("Key test failed: " + (e.message || "Invalid key"));
    } finally {
      setTestingKey(false);
    }
  };

  // ── CHANGE DAY ──
  const changeDay = (dir) => {
    const next = offsetDays + dir;
    setOffsetDays(next);
    setPhase("challenge");
    setAnalysis("");
    setConclusion("");
    setFeedback(null);
    setThread(null);
    setHintsOpen(false);
  };

  // ── GET FEEDBACK ──
  const getFeedback = useCallback(async () => {
    if (!analysis.trim() || !conclusion.trim() || !challenge) return;
    setLoadingFeedback(true);
    try {
      const text = await callGemini(apiKey, buildFeedbackPrompt(challenge, analysis, conclusion));
      setFeedback(text);
    } catch (e) {
      showToast("Feedback failed: " + e.message, "#ef4444");
    } finally {
      setLoadingFeedback(false);
    }
  }, [apiKey, analysis, conclusion, challenge, showToast]);

  // ── GENERATE THREAD ──
  const generateThread = useCallback(async () => {
    if (!analysis.trim() || !conclusion.trim() || !challenge) return;
    setLoadingThread(true);
    try {
      const raw = await callGemini(apiKey, buildThreadPrompt(challenge, analysis, conclusion, challenge.day));
      const tweets = raw.split("---TWEET---").map(t => t.trim()).filter(Boolean);
      setThread(tweets);
      setPhase("tweet");

      // Bump streak + save history
      const newStreak = bumpStreak();
      setStreak(newStreak);
      const entry = {
        date: todayKey(), day: challenge.day,
        title: challenge.title, category: challenge.category,
        difficulty: challenge.diff, analysis: analysis.slice(0, 120),
      };
      pushHistory(entry);
      setHistory(loadHistory());
      showToast(`🔥 Thread ready! Streak: ${newStreak} day${newStreak !== 1 ? "s" : ""}`, "#f59e0b");
    } catch (e) {
      showToast("Thread generation failed: " + e.message, "#ef4444");
    } finally {
      setLoadingThread(false);
    }
  }, [apiKey, analysis, conclusion, challenge, showToast]);

  const copyTweet = (text, idx) => {
    navigator.clipboard.writeText(text);
    setCopied(idx);
    setTimeout(() => setCopied(null), 2000);
  };

  const copyAll = () => {
    if (!thread) return;
    navigator.clipboard.writeText(thread.join("\n\n"));
    showToast("All tweets copied to clipboard!");
  };

  const openTwitter = (text) => {
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank");
  };

  const { cat, diff, day } = getTodayMeta(offsetDays);
  const streakToday = loadStreak().last === todayKey();

  // ══════════════════════════════════════════════════════════════════════════
  // STYLES
  // ══════════════════════════════════════════════════════════════════════════
  const S = {
    root: {
      minHeight: "100vh",
      background: "#050508",
      color: "#c8c8c8",
      fontFamily: "'Courier New', 'Lucida Console', monospace",
      position: "relative",
      overflowX: "hidden",
    },
    grid: {
      position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
      backgroundImage: `
        linear-gradient(rgba(0,201,167,0.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,201,167,0.025) 1px, transparent 1px)`,
      backgroundSize: "48px 48px",
    },
    scanlines: {
      position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
      background: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 4px)",
    },
    wrap: { position: "relative", zIndex: 1, maxWidth: 920, margin: "0 auto", padding: "0 20px 80px" },
  };

  const Btn = ({ children, onClick, disabled, variant = "ghost", style = {} }) => {
    const variants = {
      ghost:   { bg: "none",    border: "#1a3a1a", color: "#3a7a3a" },
      primary: { bg: "linear-gradient(135deg,#003a28,#005a3a)", border: "#00c9a7", color: "#00c9a7" },
      dim:     { bg: "none",    border: "#0d2a0d", color: "#2a5a2a" },
      twitter: { bg: "linear-gradient(135deg,#001523,#003050)", border: "#1d9bf0", color: "#1d9bf0" },
      danger:  { bg: "none",    border: "#3a1a1a", color: "#7a3a3a" },
    };
    const v = variants[variant];
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          background: v.bg, border: `1px solid ${v.border}`, color: v.color,
          fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.38 : 1, letterSpacing: "0.12em",
          fontSize: 10, borderRadius: 3, padding: "8px 14px",
          transition: "opacity 0.15s, border-color 0.15s",
          ...style,
        }}
      >
        {children}
      </button>
    );
  };

  const Textarea = ({ value, onChange, placeholder, minHeight = 140 }) => (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%", minHeight, background: "#060c06",
        border: "1px solid #1a3a1a", borderRadius: 4, color: "#b8dab8",
        fontFamily: "'Courier New', monospace", fontSize: 12, lineHeight: 1.75,
        padding: "14px 16px", resize: "vertical", outline: "none",
        boxSizing: "border-box",
      }}
      onFocus={e => { e.target.style.borderColor = "#00c9a7"; e.target.style.boxShadow = "0 0 0 1px #00c9a720"; }}
      onBlur={e  => { e.target.style.borderColor = "#1a3a1a"; e.target.style.boxShadow = "none"; }}
    />
  );

  // ══════════════════════════════════════════════════════════════════════════
  // API KEY SCREEN
  // ══════════════════════════════════════════════════════════════════════════
  if (!apiKey) return (
    <div style={S.root}>
      <div style={S.grid} /> <div style={S.scanlines} />
      <div style={{ ...S.wrap, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: 0 }}>

        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⛓</div>
          <div style={{ fontSize: 13, letterSpacing: "0.25em", color: "#00c9a7", fontWeight: 700, marginBottom: 6 }}>
            ONCHAIN_DOJO
          </div>
          <div style={{ fontSize: 10, color: "#2a5a2a", letterSpacing: "0.12em" }}>
            DAILY AI-GENERATED PRACTICE · BUILD IN PUBLIC ON X
          </div>
        </div>

        <div style={{
          background: "#080d08", border: "1px solid #1a3a1a",
          borderRadius: 6, padding: "32px 36px", width: "100%", maxWidth: 460,
        }}>
          <div style={{ fontSize: 9, color: "#2a6a2a", letterSpacing: "0.15em", marginBottom: 20 }}>
            // CONNECT GEMINI API
          </div>

          <div style={{ fontSize: 11, color: "#3a6a3a", lineHeight: 1.8, marginBottom: 24 }}>
            Every day, Gemini AI generates a brand-new onchain analysis challenge. You analyze it, get AI feedback, then auto-generate a tweet thread to post on X.<br /><br />
            Your key is stored locally and never sent anywhere except Google's API.
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 9, color: "#2a5a2a", letterSpacing: "0.12em", marginBottom: 8 }}>
              GEMINI API KEY
            </div>
            <input
              type="password"
              value={apiKeyInput}
              onChange={e => { setApiKeyInput(e.target.value); setApiKeyError(""); }}
              placeholder="AIza..."
              onKeyDown={e => e.key === "Enter" && handleSaveKey()}
              style={{
                width: "100%", background: "#050a05", border: "1px solid #1a3a1a",
                borderRadius: 4, color: "#b8d8b8", fontFamily: "inherit",
                fontSize: 12, padding: "10px 14px", outline: "none", boxSizing: "border-box",
              }}
              onFocus={e => e.target.style.borderColor = "#00c9a7"}
              onBlur={e  => e.target.style.borderColor = "#1a3a1a"}
            />
            {apiKeyError && (
              <div style={{ fontSize: 10, color: "#ef4444", marginTop: 6 }}>{apiKeyError}</div>
            )}
          </div>

          <Btn
            onClick={handleSaveKey}
            disabled={testingKey || !apiKeyInput.trim()}
            variant="primary"
            style={{ width: "100%", padding: "12px", fontSize: 11 }}
          >
            {testingKey ? "TESTING_KEY..." : "CONNECT_AND_START →"}
          </Btn>

          <div style={{ marginTop: 20, fontSize: 10, color: "#1a3a1a", lineHeight: 1.8 }}>
            Get a free key → <span style={{ color: "#2a6a5a" }}>aistudio.google.com</span><br/>
            Model used: <span style={{ color: "#2a5a4a" }}>gemini-2.5-flash-preview-04-17</span> (free tier works)
          </div>
        </div>
      </div>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN APP
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div style={S.root}>
      <div style={S.grid} /> <div style={S.scanlines} />

      {/* TOAST */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          background: "#0a140a", border: `1px solid ${toast.color}`,
          color: toast.color, padding: "10px 20px", borderRadius: 4,
          fontSize: 11, letterSpacing: "0.1em", zIndex: 9999,
          boxShadow: `0 0 20px ${toast.color}30`,
          animation: "fadein 0.25s ease",
        }}>
          {toast.msg}
        </div>
      )}

      <div style={S.wrap}>

        {/* ── HEADER ── */}
        <div style={{ borderBottom: "1px solid #0d1a0d", padding: "16px 0 14px", marginBottom: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.22em", color: "#00c9a7", fontWeight: 700, border: "1px solid #00c9a740", padding: "4px 10px", borderRadius: 2 }}>
                ONCHAIN_DOJO
              </div>
              <div style={{ fontSize: 9, color: "#1a3a1a", letterSpacing: "0.1em" }}>
                POWERED BY GEMINI AI
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              {/* Streak badge */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 16, filter: streakToday ? "none" : "grayscale(1)", opacity: streakToday ? 1 : 0.4 }}>🔥</span>
                <div>
                  <div style={{ fontSize: 12, color: streakToday ? "#f59e0b" : "#2a4a2a", fontWeight: 700 }}>{streak}</div>
                  <div style={{ fontSize: 8, color: "#1a3a1a" }}>STREAK</div>
                </div>
              </div>
              <Btn onClick={() => setShowHistory(v => !v)} variant="dim">
                {showHistory ? "CLOSE" : "HISTORY"}
              </Btn>
              <Btn onClick={() => { saveApiKey(""); setApiKey(""); }} variant="danger" style={{ fontSize: 9 }}>
                ⌫ KEY
              </Btn>
            </div>
          </div>
        </div>

        {/* ── HISTORY PANEL ── */}
        {showHistory && (
          <div style={{ background: "#060b06", border: "1px solid #0d1a0d", borderTop: "none", padding: "16px 20px" }}>
            <div style={{ fontSize: 9, color: "#00c9a7", letterSpacing: "0.15em", marginBottom: 12 }}>// COMPLETED CHALLENGES</div>
            {history.length === 0
              ? <div style={{ fontSize: 11, color: "#1a3a1a" }}>No entries yet — complete your first challenge below.</div>
              : history.map((h, i) => (
                <div key={i} style={{ display: "flex", gap: 12, padding: "5px 0", borderBottom: "1px solid #080d08", fontSize: 10, flexWrap: "wrap" }}>
                  <span style={{ color: "#1a4a1a", minWidth: 55 }}>Day {h.day}</span>
                  <span style={{ color: "#00c9a7", minWidth: 70 }}>[{(h.category || "").split(" ")[0]}]</span>
                  <span style={{ color: DIFF_COLORS[h.difficulty] || "#3a6a3a", minWidth: 90 }}>{h.difficulty}</span>
                  <span style={{ color: "#4a7a4a", flex: 1 }}>{h.title}</span>
                  <span style={{ color: "#1a3a1a" }}>{h.date}</span>
                </div>
              ))
            }
          </div>
        )}

        {/* ── DAY NAV BAR ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0 12px", borderBottom: "1px solid #0a140a" }}>
          <Btn onClick={() => changeDay(-1)} style={{ padding: "6px 10px" }}>‹</Btn>

          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 9, color: "#2a5a2a", letterSpacing: "0.14em" }}>
              {offsetDays === 0 ? `TODAY // DAY_${String(day).padStart(3,"0")}` : offsetDays > 0 ? `FUTURE // DAY_${String(day).padStart(3,"0")}` : `PAST // DAY_${String(day).padStart(3,"0")}`}
            </div>
            <div style={{ fontSize: 11, color: "#3a7a3a", marginTop: 3, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14 }}>{cat.emoji}</span>
              <span style={{ color: cat.color }}>{cat.label}</span>
              <span style={{ color: "#1a3a1a" }}>·</span>
              <span style={{ color: DIFF_COLORS[diff] }}>{diff}</span>
            </div>
          </div>

          <div style={{ fontSize: 9, color: "#1a4a1a", textAlign: "right" }}>
            <div>{todayKey()}</div>
            <div style={{ color: "#0d2a0d" }}>AI GENERATED</div>
          </div>

          <Btn onClick={() => changeDay(1)} style={{ padding: "6px 10px" }}>›</Btn>
        </div>

        {/* ── GENERATING STATE ── */}
        {generating && (
          <div style={{ textAlign: "center", padding: "80px 20px" }}>
            <div style={{ fontSize: 11, color: "#22c55e", letterSpacing: "0.18em", marginBottom: 8 }}>
              SEARCHING WEB FOR REAL ONCHAIN EVENT<Cursor />
            </div>
            <div style={{ fontSize: 10, color: "#1a4a2a", letterSpacing: "0.1em", marginBottom: 24 }}>
              Gemini is scanning Glassnode, Nansen, DeFiLlama, CryptoQuant, news...
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              {[...Array(5)].map((_, i) => (
                <div key={i} style={{
                  width: 6, height: 6, borderRadius: "50%", background: "#22c55e",
                  animation: `pulse 1.2s ${i * 0.2}s infinite`,
                  opacity: 0.3,
                }} />
              ))}
            </div>
            <div style={{ fontSize: 10, color: "#1a4a1a", marginTop: 20 }}>Category: {cat.label} · Difficulty: {diff}</div>
            <div style={{ fontSize: 9, color: "#0d2a0d", marginTop: 8 }}>Takes 5-10 seconds — result will be a real, verifiable event</div>
            <style>{`@keyframes pulse { 0%,100%{opacity:0.2;transform:scale(1)} 50%{opacity:1;transform:scale(1.4)} }`}</style>
          </div>
        )}

        {/* ── ERROR STATE ── */}
        {genError && !generating && (
          <div style={{ padding: "40px 0" }}>
            <div style={{ background: "#0d0505", border: "1px solid #3a1a1a", borderLeft: "3px solid #ef4444", padding: "20px 24px", borderRadius: "0 4px 4px 0" }}>
              <div style={{ fontSize: 9, color: "#ef4444", letterSpacing: "0.15em", marginBottom: 10 }}>// GENERATION_ERROR</div>
              <div style={{ fontSize: 12, color: "#8a5a5a", lineHeight: 1.7 }}>{genError}</div>
              <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
                <Btn onClick={() => loadOrGenerateChallenge(offsetDays, apiKey)} variant="primary">RETRY</Btn>
                <Btn onClick={() => { saveApiKey(""); setApiKey(""); }} variant="danger">CHANGE KEY</Btn>
              </div>
            </div>
          </div>
        )}

        {/* ── MAIN CONTENT (challenge loaded) ── */}
        {challenge && !generating && !genError && (
          <>
            {/* PHASE TABS */}
            <div style={{ display: "flex", borderBottom: "1px solid #0a140a" }}>
              {["challenge", "workspace", "tweet"].map((p, i) => (
                <button key={p} onClick={() => setPhase(p)} style={{
                  background: "none", border: "none",
                  borderBottom: phase === p ? "2px solid #00c9a7" : "2px solid transparent",
                  color: phase === p ? "#00c9a7" : "#2a4a2a",
                  padding: "10px 18px", cursor: "pointer", fontFamily: "inherit",
                  fontSize: 10, letterSpacing: "0.12em", marginBottom: -1,
                }}>
                  {`0${i+1}_${p.toUpperCase()}`}
                  {p === "tweet" && thread && <span style={{ marginLeft: 6, fontSize: 8, color: "#f59e0b", border: "1px solid #f59e0b40", padding: "1px 5px", borderRadius: 10 }}>READY</span>}
                </button>
              ))}
            </div>

            {/* ═══════════════════════════════════ */}
            {/* PHASE 1: CHALLENGE                  */}
            {/* ═══════════════════════════════════ */}
            {phase === "challenge" && (
              <div style={{ paddingTop: 28 }}>

                {/* Title + badges */}
                <div style={{ marginBottom: 22 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 12 }}>
                    <div style={{
                      width: 48, height: 48, borderRadius: 8,
                      background: `linear-gradient(135deg, ${cat.color}20, ${cat.color}08)`,
                      border: `1px solid ${cat.color}40`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 22, flexShrink: 0,
                    }}>{cat.emoji}</div>
                    <div>
                      <h1 style={{ fontSize: 20, fontWeight: 700, color: "#e8e8e8", margin: "0 0 8px", fontFamily: "inherit" }}>
                        {challenge.title}
                      </h1>
                      <div style={{ display: "flex", gap: 8 }}>
                        <span style={{ fontSize: 9, padding: "2px 8px", letterSpacing: "0.12em", background: cat.color + "15", border: `1px solid ${cat.color}40`, color: cat.color, borderRadius: 2 }}>
                          {cat.label.toUpperCase()}
                        </span>
                        <span style={{ fontSize: 9, padding: "2px 8px", letterSpacing: "0.12em", background: DIFF_COLORS[diff] + "15", border: `1px solid ${DIFF_COLORS[diff]}40`, color: DIFF_COLORS[diff], borderRadius: 2 }}>
                          {diff.toUpperCase()}
                        </span>
                        <span style={{ fontSize: 9, padding: "2px 8px", letterSpacing: "0.1em", background: "#0d1a0d", border: "1px solid #1a3a1a", color: "#2a5a2a", borderRadius: 2 }}>
                          AI · {todayKey()}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Problem */}
                <div style={{
                  background: "#080d08", border: "1px solid #1a3a1a",
                  borderLeft: `3px solid ${cat.color}`, padding: "20px 24px",
                  marginBottom: 20, borderRadius: "0 4px 4px 0",
                }}>
                  <div style={{ fontSize: 9, color: "#2a6a2a", letterSpacing: "0.15em", marginBottom: 12 }}>// SCENARIO</div>
                  <p style={{ fontSize: 13, lineHeight: 1.85, color: "#c8c8c8", margin: 0 }}>
                    {challenge.problem}
                  </p>
                </div>

                {/* Real event source */}
                {challenge.realEvent && (
                  <div style={{
                    background: "#07100a", border: "1px solid #1a4a25",
                    borderLeft: "3px solid #22c55e", padding: "14px 18px",
                    marginBottom: 12, borderRadius: "0 4px 4px 0",
                  }}>
                    <div style={{ fontSize: 9, color: "#22c55e", letterSpacing: "0.15em", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ background: "#22c55e20", border: "1px solid #22c55e50", padding: "2px 8px", borderRadius: 10 }}>REAL EVENT</span>
                      <span style={{ color: "#1a4a25" }}>verifiable onchain data</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#4a9a5a", lineHeight: 1.75, marginBottom: 8 }}>
                      {challenge.realEvent}
                    </div>
                    {challenge.source && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 9, color: "#1a4a25", letterSpacing: "0.1em" }}>SOURCE:</span>
                        {challenge.source.startsWith("http") ? (
                          <a href={challenge.source} target="_blank" rel="noopener noreferrer"
                            style={{ fontSize: 10, color: "#00c9a7", textDecoration: "none", borderBottom: "1px solid #00c9a730", wordBreak: "break-all" }}>
                            {challenge.source} ↗
                          </a>
                        ) : (
                          <span style={{ fontSize: 10, color: "#3a7a5a" }}>{challenge.source}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Teaching point */}
                <div style={{
                  background: "#06090a", border: "1px solid #0d2030",
                  borderLeft: "3px solid #0ea5e9", padding: "12px 18px",
                  marginBottom: 20, borderRadius: "0 4px 4px 0", fontSize: 11, color: "#2a6a8a", lineHeight: 1.7,
                }}>
                  <span style={{ color: "#0ea5e960", marginRight: 8 }}>// WHAT_YOU_LEARN:</span>
                  {challenge.teachingPoint}
                </div>

                {/* Metrics + Tools grid */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
                  <div style={{ background: "#080d08", border: "1px solid #0d1a0d", padding: "14px 16px", borderRadius: 4 }}>
                    <div style={{ fontSize: 9, color: "#2a5a2a", letterSpacing: "0.15em", marginBottom: 10 }}>// KEY_METRICS_TO_CHECK</div>
                    {(challenge.keyMetrics || []).map((m, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#4a7a4a", padding: "3px 0", display: "flex", gap: 8 }}>
                        <span style={{ color: "#1a4a1a" }}>›</span> {m}
                      </div>
                    ))}
                  </div>
                  <div style={{ background: "#080d08", border: "1px solid #0d1a0d", padding: "14px 16px", borderRadius: 4 }}>
                    <div style={{ fontSize: 9, color: "#2a5a2a", letterSpacing: "0.15em", marginBottom: 10 }}>// TOOLS_TO_USE</div>
                    {(challenge.tools || []).map((t, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#4a7a4a", padding: "3px 0", display: "flex", gap: 8 }}>
                        <span style={{ color: "#1a4a1a" }}>›</span> {t}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Hints */}
                <button onClick={() => setHintsOpen(v => !v)} style={{
                  background: "none", border: "1px solid #0d2a0d", color: "#2a5a2a",
                  padding: "8px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 10,
                  letterSpacing: "0.1em", borderRadius: 3, marginBottom: 12, width: "100%", textAlign: "left",
                }}>
                  {hintsOpen ? "▾ HIDE" : "▸ SHOW"} HINTS ({(challenge.hints || []).length})
                </button>

                {hintsOpen && (
                  <div style={{ background: "#050a05", border: "1px solid #1a3a1a", padding: "14px 18px", borderRadius: 4, marginBottom: 20 }}>
                    {(challenge.hints || []).map((h, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#4a8a4a", lineHeight: 1.75, padding: "4px 0", display: "flex", gap: 10 }}>
                        <span style={{ color: "#f59e0b", flexShrink: 0 }}>[{i+1}]</span> {h}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: "flex", gap: 10 }}>
                  <Btn onClick={() => loadOrGenerateChallenge(offsetDays, apiKey, true)} variant="dim" style={{ flex: 1 }}>
                    ↺ REGENERATE
                  </Btn>
                  <Btn onClick={() => setPhase("workspace")} variant="primary" style={{ flex: 3, padding: "13px", fontSize: 11 }}>
                    BEGIN_ANALYSIS →
                  </Btn>
                </div>
              </div>
            )}

            {/* ═══════════════════════════════════ */}
            {/* PHASE 2: WORKSPACE                  */}
            {/* ═══════════════════════════════════ */}
            {phase === "workspace" && (
              <div style={{ paddingTop: 24 }}>

                {/* Mini problem recap */}
                <div style={{
                  background: "#080d08", border: "1px solid #0d1a0d",
                  padding: "10px 14px", marginBottom: 20, borderRadius: 4,
                  fontSize: 11, color: "#3a6a3a", lineHeight: 1.6,
                }}>
                  <span style={{ color: "#1a4a1a", marginRight: 8 }}>// {challenge.title}</span>
                  {challenge.problem.slice(0, 130)}...
                  <button onClick={() => setPhase("challenge")} style={{
                    background: "none", border: "none", color: "#00c9a7",
                    cursor: "pointer", fontFamily: "inherit", fontSize: 10, marginLeft: 8,
                  }}>see full ↗</button>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: "#2a6a2a", letterSpacing: "0.15em", marginBottom: 8 }}>
                    // YOUR_ANALYSIS — what does the data mean? what patterns do you see?
                  </div>
                  <Textarea
                    value={analysis}
                    onChange={setAnalysis}
                    placeholder={`Break down the onchain signals. Reference specific metrics. Explain what's happening and why it matters...`}
                    minHeight={160}
                  />
                  <div style={{ textAlign: "right", fontSize: 9, color: "#1a3a1a", marginTop: 4 }}>
                    {analysis.length} chars
                  </div>
                </div>

                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontSize: 9, color: "#2a6a2a", letterSpacing: "0.15em", marginBottom: 8 }}>
                    // YOUR_CONCLUSION — the actionable insight or answer
                  </div>
                  <Textarea
                    value={conclusion}
                    onChange={setConclusion}
                    placeholder={`What's your final read? What would you watch next? What's the trade or signal here?`}
                    minHeight={90}
                  />
                </div>

                <div style={{ display: "flex", gap: 10 }}>
                  <Btn
                    onClick={getFeedback}
                    disabled={loadingFeedback || !analysis.trim() || !conclusion.trim()}
                    variant="ghost"
                    style={{ flex: 1, padding: "12px" }}
                  >
                    {loadingFeedback ? "ANALYZING..." : "GET_AI_FEEDBACK"}
                  </Btn>
                  <Btn
                    onClick={generateThread}
                    disabled={loadingThread || !analysis.trim() || !conclusion.trim()}
                    variant="primary"
                    style={{ flex: 2, padding: "12px", fontSize: 11 }}
                  >
                    {loadingThread ? "GENERATING_THREAD..." : "GENERATE_TWEET_THREAD →"}
                  </Btn>
                </div>

                {/* AI Feedback */}
                {feedback && (
                  <div style={{
                    background: "#060c06", border: "1px solid #1a4a1a",
                    borderLeft: "3px solid #00c9a7", padding: "18px 22px",
                    borderRadius: "0 4px 4px 0", marginTop: 20,
                  }}>
                    <div style={{ fontSize: 9, color: "#00c9a7", letterSpacing: "0.15em", marginBottom: 14 }}>
                      // GEMINI_MENTOR_FEEDBACK
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.85, color: "#7ab87a", whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
                      {feedback}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ═══════════════════════════════════ */}
            {/* PHASE 3: TWEET THREAD               */}
            {/* ═══════════════════════════════════ */}
            {phase === "tweet" && (
              <div style={{ paddingTop: 24 }}>
                {!thread ? (
                  <div style={{ textAlign: "center", padding: "60px 0" }}>
                    <div style={{ fontSize: 11, color: "#1a3a1a", letterSpacing: "0.15em", marginBottom: 16 }}>
                      // NO_THREAD_YET
                    </div>
                    <p style={{ fontSize: 12, color: "#2a5a2a" }}>Write your analysis first, then generate the thread.</p>
                    <Btn onClick={() => setPhase("workspace")} variant="ghost" style={{ marginTop: 16 }}>GO_TO_WORKSPACE →</Btn>
                  </div>
                ) : (
                  <>
                    {/* Thread controls */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
                      <div style={{ fontSize: 9, color: "#2a6a2a", letterSpacing: "0.15em" }}>
                        // THREAD_READY — {thread.length} TWEETS
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Btn onClick={copyAll} variant="ghost" style={{ fontSize: 9 }}>COPY_ALL</Btn>
                        <Btn onClick={generateThread} disabled={loadingThread} variant="ghost" style={{ fontSize: 9 }}>
                          {loadingThread ? "..." : "↺ REGEN"}
                        </Btn>
                        <Btn onClick={() => openTwitter(thread[0])} variant="twitter">
                          𝕏 POST TWEET 1 ↗
                        </Btn>
                      </div>
                    </div>

                    {/* Tweet cards */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {thread.map((tweet, i) => (
                        <div key={i} style={{ position: "relative" }}>
                          {/* connector line */}
                          {i < thread.length - 1 && (
                            <div style={{ position: "absolute", left: 14, bottom: -10, width: 1, height: 10, background: "#1a3a1a" }} />
                          )}
                          <div style={{ background: "#080d08", border: "1px solid #1a3a1a", borderRadius: 5, padding: "14px 16px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{
                                  width: 18, height: 18, borderRadius: "50%",
                                  background: `linear-gradient(135deg, ${cat.color}, #00c9a7)`,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  fontSize: 8, fontWeight: 700, color: "#000", flexShrink: 0,
                                }}>{i + 1}</div>
                                <span style={{ fontSize: 9, color: "#1a5a1a", letterSpacing: "0.1em" }}>
                                  TWEET_{String(i+1).padStart(2,"0")}
                                </span>
                              </div>
                              <div style={{ display: "flex", gap: 6 }}>
                                <button onClick={() => copyTweet(tweet, i)} style={{
                                  background: copied === i ? "#003a2a" : "none",
                                  border: `1px solid ${copied === i ? "#00c9a7" : "#1a3a1a"}`,
                                  color: copied === i ? "#00c9a7" : "#2a5a2a",
                                  padding: "3px 10px", cursor: "pointer",
                                  fontFamily: "inherit", fontSize: 9, letterSpacing: "0.08em", borderRadius: 2,
                                }}>
                                  {copied === i ? "COPIED!" : "COPY"}
                                </button>
                                <button onClick={() => openTwitter(tweet)} style={{
                                  background: "none", border: "1px solid #0d2a3a", color: "#1d6fa0",
                                  padding: "3px 10px", cursor: "pointer",
                                  fontFamily: "inherit", fontSize: 9, letterSpacing: "0.08em", borderRadius: 2,
                                }}>
                                  𝕏 POST
                                </button>
                              </div>
                            </div>
                            <div style={{ fontSize: 12, lineHeight: 1.8, color: "#a8c8a8", whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
                              {tweet}
                            </div>
                            <div style={{ marginTop: 10 }}>
                              <ProgressBar value={tweet.length} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Instructions */}
                    <div style={{
                      marginTop: 20, background: "#050a05", border: "1px solid #0d1a0d",
                      padding: "14px 18px", borderRadius: 4, fontSize: 10, color: "#2a5a2a", lineHeight: 1.85,
                    }}>
                      <div style={{ color: "#00c9a7", marginBottom: 6, letterSpacing: "0.1em" }}>// HOW_TO_POST</div>
                      [1] Click "POST TWEET 1 ↗" — X opens with Tweet 1 pre-filled<br/>
                      [2] Post it → click reply to your own tweet for Tweet 2<br/>
                      [3] Use COPY buttons to paste each reply<br/>
                      [4] Or paste all into <span style={{ color: "#3a6a5a" }}>Typefully / Tweetdeck</span> for scheduled threads
                    </div>

                    {/* Next day teaser */}
                    <div style={{
                      marginTop: 14, display: "flex", justifyContent: "space-between",
                      alignItems: "center", background: "#080d08", border: "1px solid #0a140a",
                      padding: "14px 18px", borderRadius: 4,
                    }}>
                      <div>
                        <div style={{ fontSize: 9, color: "#1a3a1a", letterSpacing: "0.1em" }}>TOMORROW'S CATEGORY</div>
                        <div style={{ fontSize: 12, color: "#4a7a4a", marginTop: 4 }}>
                          {getTodayMeta(offsetDays + 1).cat.emoji} {getTodayMeta(offsetDays + 1).cat.label}
                          <span style={{ fontSize: 10, color: DIFF_COLORS[getTodayMeta(offsetDays + 1).diff], marginLeft: 10 }}>
                            {getTodayMeta(offsetDays + 1).diff}
                          </span>
                        </div>
                        <div style={{ fontSize: 9, color: "#1a3a1a", marginTop: 2 }}>New challenge auto-generated at midnight</div>
                      </div>
                      <Btn onClick={() => changeDay(1)} variant="ghost">NEXT_DAY →</Btn>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* FOOTER */}
        <div style={{
          marginTop: 48, borderTop: "1px solid #0a140a", padding: "14px 0",
          display: "flex", justifyContent: "space-between", fontSize: 9, color: "#1a3a1a", letterSpacing: "0.08em",
        }}>
          <span>ONCHAIN_DOJO // BUILD IN PUBLIC</span>
          <span>GEMINI-2.0-FLASH · {todayKey()}</span>
        </div>
      </div>

      <style>{`
        @keyframes fadein { from{opacity:0;transform:translateX(-50%) translateY(10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
      `}</style>
    </div>
  );
}
