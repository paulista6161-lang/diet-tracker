import { useState, useRef, useEffect } from "react";

const STORAGE_KEY = "diet_tracker_data_v2";

const defaultState = {
  setup: { tdee: 2000, targetDeficit: 500, startWeight: 60 },
  setupDone: false,
  logs: [],
  bodyLogs: [], // { date, weight, bmi, fatRate, muscleMass, bmr, visceralFat, skeletalMuscleRate, boneMass, bodyWater, bodyAge }
};

function loadState() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : defaultState;
  } catch { return defaultState; }
}
function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function getTodayLog(logs) {
  const today = todayStr();
  return logs.find(l => l.date === today) || { date: today, meals: [], weight: null };
}

export default function App() {
  const [state, setState] = useState(loadState);
  const [tab, setTab] = useState("dashboard");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingBody, setAnalyzingBody] = useState(false);
  const [mealPhotos, setMealPhotos] = useState([]); // [{url, base64, mediaType}]
  const [mealMemo, setMealMemo] = useState("");
  const [mealResult, setMealResult] = useState(null);
  const [confirmItems, setConfirmItems] = useState(null);
  const [weightInput, setWeightInput] = useState("");
  const [setupForm, setSetupForm] = useState(state.setup);
  const [bodyPhoto, setBodyPhoto] = useState(null);
  const [bodyPhotoBase64, setBodyPhotoBase64] = useState(null);
  const [bodyResult, setBodyResult] = useState(null);
  const [editingBody, setEditingBody] = useState(null);
  const fileRef = useRef();
  const bodyFileRef = useRef();

  useEffect(() => { saveState(state); }, [state]);

  const todayLog = getTodayLog(state.logs);
  const totalToday = todayLog.meals.reduce((acc, m) => ({
    calories: acc.calories + (m.calories || 0),
    protein: acc.protein + (m.protein || 0),
    fat: acc.fat + (m.fat || 0),
    carbs: acc.carbs + (m.carbs || 0),
  }), { calories: 0, protein: 0, fat: 0, carbs: 0 });

  const targetCal = state.setup.tdee - state.setup.targetDeficit;
  const todayDeficit = targetCal - totalToday.calories;
  const todayLogged = state.logs.find(l => l.date === todayStr());
  const cumulativeDeficit = state.logs.reduce((acc, log) => {
    if (log.skipped) return acc; // skipped days = ±0
    const logTotal = log.meals.reduce((s, m) => s + (m.calories || 0), 0);
    return acc + (targetCal - logTotal);
  }, 0) + (todayLogged ? 0 : todayDeficit);
  const predictedFatLoss = (cumulativeDeficit / 7200).toFixed(2);

  function skipToday() {
    setState(prev => {
      const logs = [...prev.logs];
      const idx = logs.findIndex(l => l.date === todayStr());
      if (idx >= 0) logs[idx] = { ...logs[idx], skipped: true, meals: [] };
      else logs.push({ date: todayStr(), meals: [], weight: null, skipped: true });
      return { ...prev, logs };
    });
  }
  function unskipToday() {
    setState(prev => {
      const logs = [...prev.logs];
      const idx = logs.findIndex(l => l.date === todayStr());
      if (idx >= 0) logs[idx] = { ...logs[idx], skipped: false };
      return { ...prev, logs };
    });
  }

  const latestBody = state.bodyLogs.length > 0
    ? [...state.bodyLogs].sort((a, b) => b.date.localeCompare(a.date))[0]
    : null;

  // Food analysis
  async function analyzeFood(extraItems) {
    if (!mealMemo && !mealPhotos.length) return;
    setAnalyzing(true); setMealResult(null); setConfirmItems(null);
    try {
      const content = [];
      // Add all photos with correct media type
      mealPhotos.forEach(p => content.push({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } }));

      const hasPhoto = mealPhotos.length > 0;
      const hasMemo = !!mealMemo.trim();
      const confirmedExtra = extraItems ? extraItems.filter(i => i.eaten).map(i => i.name).join("、") : "";

      let prompt = "";
      if (hasPhoto && hasMemo) {
        prompt = `写真とメモの両方から食事を分析してください。
メモの内容:
${mealMemo}
${confirmedExtra ? `\n追加で食べていた食材（写真から確認済み）: ${confirmedExtra}` : ""}

【重要】写真とメモを照合して、メモに書かれていないが写真に写っている食材があれば "photoOnly" に列挙してください。
ただし既に確認済みの食材(${confirmedExtra})は除外してください。

JSON形式のみで返答（他テキスト不要）:
{"calories": 数値, "protein": 数値, "fat": 数値, "carbs": 数値, "description": "説明", "notes": "アドバイス", "photoOnly": ["写真のみの食材名", ...]}`;
      } else if (hasPhoto) {
        prompt = `写真から食事の内容を読み取り、カロリーとPFCを推定してください。
JSON形式のみで返答（他テキスト不要）:
{"calories": 数値, "protein": 数値, "fat": 数値, "carbs": 数値, "description": "説明", "notes": "アドバイス", "photoOnly": []}`;
      } else {
        prompt = `以下の食事メモからカロリーとPFCを推定してください。朝・昼・晩・間食などが混在していても全部合計してください。
${mealMemo}

JSON形式のみで返答（他テキスト不要）:
{"calories": 数値, "protein": 数値, "fat": 数値, "carbs": 数値, "description": "説明", "notes": "アドバイス", "photoOnly": []}`;
      }

      content.push({ type: "text", text: prompt });

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content }] })
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error("API Error " + res.status + ": " + errText.slice(0, 200));
      }
      const data = await res.json();
      const text = data.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
      if (!text) throw new Error("Empty response from API");

      // Try to extract JSON from response
      let parsed;
      try {
        // Try direct parse first
        const clean = text.replace(/```json|```/g, "").trim();
        // Find JSON object in text
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON found in: " + clean.slice(0, 100));
        parsed = JSON.parse(jsonMatch[0]);
      } catch(parseErr) {
        throw new Error("JSON parse failed: " + parseErr.message);
      }

      // If there are items in photo not in memo, ask for confirmation first
      if (parsed.photoOnly && parsed.photoOnly.length > 0 && !extraItems) {
        setConfirmItems(parsed.photoOnly.map(name => ({ name, eaten: true })));
        setAnalyzing(false);
        return;
      }

      setMealResult(parsed);
    } catch(err) {
      setMealResult({ error: "分析に失敗しました: " + (err?.message || String(err)) });
    }
    setAnalyzing(false);
  }

  // Body composition analysis
  async function analyzeBodyPhoto() {
    if (!bodyPhotoBase64) return;
    setAnalyzingBody(true); setBodyResult(null);
    try {
      const content = [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: bodyPhotoBase64 } },
        { type: "text", text: `この体組成計の画面から数値を読み取ってください。
読み取れる項目すべてをJSONで返してください（読み取れない項目はnullにする）。
JSON形式のみで返答（他テキスト不要）:
{
  "weight": 体重(kg数値またはnull),
  "bmi": BMI(数値またはnull),
  "fatRate": 体脂肪率(数値またはnull),
  "muscleMass": 筋肉量または除脂肪体重(kg数値またはnull),
  "bmr": 基礎代謝(kcal数値またはnull),
  "visceralFat": 内臓脂肪レベル(数値またはnull),
  "skeletalMuscleRate": 骨格筋率(数値またはnull),
  "boneMass": 骨量(kg数値またはnull),
  "bodyWater": 体水分率(数値またはnull),
  "bodyAge": 体内年齢(数値またはnull),
  "notes": "AIからの一言アドバイス"
}` }
      ];
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content }] })
      });
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "";
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      setBodyResult(parsed);
      setEditingBody(parsed);
    } catch { setBodyResult({ error: "読み取りに失敗しました。もう一度試してください。" }); }
    setAnalyzingBody(false);
  }

  function saveBodyLog() {
    if (!editingBody) return;
    const entry = { date: todayStr(), ...editingBody };
    setState(prev => {
      const bodyLogs = [...prev.bodyLogs];
      const idx = bodyLogs.findIndex(l => l.date === todayStr());
      if (idx >= 0) bodyLogs[idx] = entry;
      else bodyLogs.push(entry);
      return { ...prev, bodyLogs };
    });
    setBodyPhoto(null); setBodyPhotoBase64(null); setBodyResult(null); setEditingBody(null);
    setTab("dashboard");
  }

  function addMeal() {
    if (!mealResult || mealResult.error) return;
    const meal = { memo: mealMemo, photo: mealPhoto, ...mealResult, time: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) };
    setState(prev => {
      const logs = [...prev.logs];
      const idx = logs.findIndex(l => l.date === todayStr());
      if (idx >= 0) logs[idx] = { ...logs[idx], meals: [...logs[idx].meals, meal] };
      else logs.push({ date: todayStr(), meals: [meal], weight: null });
      return { ...prev, logs };
    });
    setMealPhotos([]); setMealMemo(""); setMealResult(null); setConfirmItems(null);
    setTab("dashboard");
  }

  function saveWeight() {
    const w = parseFloat(weightInput);
    if (isNaN(w)) return;
    setState(prev => {
      const logs = [...prev.logs];
      const idx = logs.findIndex(l => l.date === todayStr());
      if (idx >= 0) logs[idx] = { ...logs[idx], weight: w };
      else logs.push({ date: todayStr(), meals: [], weight: w });
      return { ...prev, logs };
    });
    setWeightInput("");
  }

  // Simple FileReader approach - most compatible with iOS Safari
  function readFileAsBase64(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        // dataUrl format: data:image/jpeg;base64,XXXX
        const parts = dataUrl.split(",");
        const base64 = parts[1];
        // Always tell API it's jpeg - works for all common formats
        resolve({ url: dataUrl, base64, mediaType: "image/jpeg" });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  async function handlePhoto(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    for (const file of files) {
      const result = await readFileAsBase64(file);
      if (result) setMealPhotos(prev => [...prev, result]);
    }
    e.target.value = "";
  }

  async function handleBodyPhoto(e) {
    const file = e.target.files[0]; if (!file) return;
    const result = await readFileAsBase64(file);
    if (result) { setBodyPhoto(result.url); setBodyPhotoBase64(result.base64); }
  }

  if (!state.setupDone) {
    return (
      <div style={s.setupContainer}>
        <div style={s.setupCard}>
          <div style={{ fontSize: 48, textAlign: "center", marginBottom: 8 }}>🔥</div>
          <h1 style={s.setupTitle}>Diet Tracker</h1>
          <p style={s.setupSub}>まずは基本情報を入力してね</p>
          {[["TDEE（1日の消費カロリー）", "tdee", "kcal"], ["目標カロリー不足（1日）", "targetDeficit", "kcal"], ["現在の体重", "startWeight", "kg"]].map(([label, key, unit]) => (
            <div key={key} style={s.field}>
              <label style={s.label}>{label}</label>
              <div style={s.inputRow}>
                <input style={s.input} type="number" step={key === "startWeight" ? "0.1" : "1"} value={setupForm[key]}
                  onChange={e => setSetupForm(p => ({ ...p, [key]: +e.target.value }))} />
                <span style={s.unit}>{unit}</span>
              </div>
              {key === "targetDeficit" && <p style={s.hint}>目標摂取: {setupForm.tdee - setupForm.targetDeficit} kcal/日</p>}
            </div>
          ))}
          <button style={s.primaryBtn} onClick={() => setState(p => ({ ...p, setup: setupForm, setupDone: true }))}>スタート 🚀</button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.app}>
      <div style={s.header}>
        <span style={{ fontSize: 22 }}>🔥</span>
        <span style={s.headerTitle}>Diet Tracker</span>
        <button style={s.settingsBtn} onClick={() => setState(p => ({ ...p, setupDone: false }))}>⚙️</button>
      </div>

      <div style={s.content}>

        {/* DASHBOARD */}
        {tab === "dashboard" && (
          <div>
            <div style={s.heroCard}>
              <div style={s.heroTop}>
                <div>
                  <p style={s.heroLabel}>今日の摂取カロリー</p>
                  <p style={s.heroCalories}>{totalToday.calories} <span style={s.heroUnit}>kcal</span></p>
                  <p style={s.heroTarget}>目標: {targetCal} kcal</p>
                </div>
                <div style={s.deficitBadge}>
                  <span style={{ fontSize: 11, color: todayDeficit >= 0 ? "#4ade80" : "#f87171" }}>{todayDeficit >= 0 ? "余裕" : "超過"}</span>
                  <span style={{ fontSize: 20, fontWeight: 700, color: todayDeficit >= 0 ? "#4ade80" : "#f87171" }}>{Math.abs(todayDeficit)}</span>
                  <span style={{ fontSize: 11, color: "#888" }}>kcal</span>
                </div>
              </div>
              <div style={s.progressBar}><div style={{ ...s.progressFill, width: `${Math.min(100, (totalToday.calories / targetCal) * 100)}%`, background: totalToday.calories > targetCal ? "#f87171" : "#4ade80" }} /></div>
              <div style={s.pfcRow}>
                {[["P", totalToday.protein, "#60a5fa"], ["F", totalToday.fat, "#fbbf24"], ["C", totalToday.carbs, "#a78bfa"]].map(([k, v, c]) => (
                  <div key={k} style={s.pfcItem}><span style={{ ...s.pfcLabel, color: c }}>{k}</span><span style={s.pfcVal}>{v}g</span></div>
                ))}
              </div>
            </div>

            <div style={s.cumCard}>
              <div style={s.cumLeft}><p style={s.cumLabel}>累積アンダーカロリー</p><p style={s.cumValue}>{cumulativeDeficit.toLocaleString()} kcal</p></div>
              <div style={s.cumRight}><p style={s.cumLabel}>予測体脂肪減少</p><p style={{ ...s.cumValue, color: "#4ade80" }}>-{predictedFatLoss} kg</p></div>
            </div>

            {/* Latest body composition */}
            {latestBody && (
              <div style={s.bodyCard}>
                <p style={s.sectionTitle}>最新の体組成 <span style={{ fontSize: 12, color: "#888", fontWeight: 400 }}>{latestBody.date}</span></p>
                <div style={s.bodyGrid}>
                  {[
                    ["体重", latestBody.weight, "kg"],
                    ["体脂肪率", latestBody.fatRate, "%"],
                    ["骨格筋率", latestBody.skeletalMuscleRate, "%"],
                    ["基礎代謝", latestBody.bmr, "kcal"],
                    ["内臓脂肪", latestBody.visceralFat, "Lv"],
                    ["体内年齢", latestBody.bodyAge, "歳"],
                  ].filter(([, v]) => v != null).map(([label, val, unit]) => (
                    <div key={label} style={s.bodyGridItem}>
                      <span style={s.bodyGridLabel}>{label}</span>
                      <span style={s.bodyGridVal}>{val}<span style={{ fontSize: 11, color: "#888" }}>{unit}</span></span>
                    </div>
                  ))}
                </div>
                {latestBody.notes && <p style={s.resultNotes}>💡 {latestBody.notes}</p>}
              </div>
            )}

            <div style={s.weightCard}>
              <p style={s.sectionTitle}>体重記録</p>
              <div style={s.weightInputRow}>
                <input style={s.weightInput} type="number" step="0.1" placeholder="今日の体重" value={weightInput} onChange={e => setWeightInput(e.target.value)} />
                <span style={s.unit}>kg</span>
                <button style={s.smallBtn} onClick={saveWeight}>記録</button>
              </div>
              {state.logs.filter(l => l.weight).length > 0 && (
                <div style={s.weightList}>
                  {state.logs.filter(l => l.weight).slice(-5).reverse().map(l => (
                    <div key={l.date} style={s.weightRow}><span style={s.weightDate}>{l.date}</span><span style={s.weightVal}>{l.weight} kg</span></div>
                  ))}
                </div>
              )}
            </div>

            {todayLog.skipped ? (
              <div style={{ ...s.mealsCard, borderColor: "#444", marginBottom: 12 }}>
                <p style={{ color: "#888", textAlign: "center", margin: "0 0 10px" }}>📭 今日は記録なし（プラマイゼロ）</p>
                <button style={{ ...s.smallBtn, width: "100%", background: "#2a2a2a", color: "#aaa" }} onClick={unskipToday}>記録を再開する</button>
              </div>
            ) : (
              <div style={s.mealsCard}>
                <p style={s.sectionTitle}>今日の食事</p>
                {todayLog.meals.length === 0 ? (
                  <div>
                    <p style={s.emptyText}>まだ記録がありません</p>
                    <button style={{ ...s.smallBtn, width: "100%", background: "#1a1a1a", color: "#666", border: "1px solid #333", marginTop: 4 }} onClick={skipToday}>
                      📭 今日は記録しない（プラマイゼロ扱い）
                    </button>
                  </div>
                ) : todayLog.meals.map((m, i) => (
                  <div key={i} style={s.mealRow}>
                    <div style={s.mealLeft}><span style={s.mealTime}>{m.time}</span><span style={s.mealDesc}>{m.description || m.memo}</span></div>
                    <div style={s.mealRight}><span style={s.mealCal}>{m.calories} kcal</span><span style={s.mealPfc}>P:{m.protein}g F:{m.fat}g C:{m.carbs}g</span></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ADD MEAL */}
        {tab === "add" && (
          <div style={s.addContainer}>
            <p style={s.sectionTitle}>食事を記録</p>

            {/* Text input - primary */}
            <textarea style={{ ...s.memo, minHeight: 120, fontSize: 14, lineHeight: 1.7 }}
              placeholder={"食べたものを自由に入力してね\n\n例）\n朝ごはん\nフランスパン35g\nサニーレタス25g\nスモークチーズ7g\n\n昼ごはん\nリンガーハット皿うどんスモール\n餃子2個"}
              value={mealMemo} onChange={e => setMealMemo(e.target.value)} rows={6} />

            {/* Photos - secondary, multiple supported */}
            <div style={{ ...s.photoArea, height: 80 }} onClick={() => fileRef.current?.click()}>
              <div style={s.photoPlaceholder}>
                <span style={{ fontSize: 24 }}>📷</span>
                <span style={{ color: "#666", fontSize: 12 }}>写真を追加（複数OK・任意）</span>
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handlePhoto} />
            </div>
            {mealPhotos.length > 0 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {mealPhotos.map((p, i) => (
                  <div key={i} style={{ position: "relative" }}>
                    <img src={p.url} alt="food" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 8 }} />
                    <button style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,0.6)", border: "none", color: "#fff", borderRadius: "50%", width: 20, height: 20, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                      onClick={() => setMealPhotos(prev => prev.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <button style={{ ...s.primaryBtn, opacity: analyzing ? 0.6 : 1 }} onClick={() => analyzeFood(null)} disabled={analyzing || (!mealMemo && !mealPhotos.length)}>
              {analyzing ? "AI分析中..." : "🤖 AIで分析"}
            </button>

            {/* Confirmation: items found in photo but not in memo */}
            {confirmItems && (
              <div style={s.resultCard}>
                <p style={{ ...s.resultTitle, color: "#fbbf24" }}>📸 写真に見つかった食材を確認</p>
                <p style={{ color: "#aaa", fontSize: 13, marginBottom: 12 }}>メモにない食材が写真に写っています。食べましたか？</p>
                {confirmItems.map((item, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <button
                      style={{ width: 28, height: 28, borderRadius: 6, border: "none", cursor: "pointer", fontSize: 14, background: item.eaten ? "#4ade80" : "#333", color: item.eaten ? "#000" : "#666" }}
                      onClick={() => setConfirmItems(prev => prev.map((it, j) => j === i ? { ...it, eaten: !it.eaten } : it))}>
                      {item.eaten ? "✓" : "✕"}
                    </button>
                    <span style={{ color: "#ddd", fontSize: 14 }}>{item.name}</span>
                  </div>
                ))}
                <button style={s.primaryBtn} onClick={() => analyzeFood(confirmItems)}>
                  🤖 これで分析する
                </button>
              </div>
            )}

            {mealResult && !mealResult.error && (
              <div style={s.resultCard}>
                <p style={s.resultTitle}>{mealResult.description}</p>
                <div style={s.resultGrid}>
                  {[["カロリー", mealResult.calories, "kcal", "#fff"], ["タンパク質", mealResult.protein, "g", "#60a5fa"], ["脂質", mealResult.fat, "g", "#fbbf24"], ["炭水化物", mealResult.carbs, "g", "#a78bfa"]].map(([l, v, u, c]) => (
                    <div key={l} style={s.resultItem}><span style={{ ...s.resultLabel, color: c === "#fff" ? "#888" : c }}>{l}</span><span style={s.resultVal}>{v}{u}</span></div>
                  ))}
                </div>
                {mealResult.notes && <p style={s.resultNotes}>💡 {mealResult.notes}</p>}
                <button style={s.primaryBtn} onClick={addMeal}>✅ 記録する</button>
              </div>
            )}
            {mealResult?.error && <p style={{ color: "#f87171", textAlign: "center" }}>{mealResult.error}</p>}
          </div>
        )}

        {/* BODY COMPOSITION */}
        {tab === "body" && (
          <div style={s.addContainer}>
            <p style={s.sectionTitle}>体組成を記録</p>
            <div style={s.photoArea} onClick={() => bodyFileRef.current?.click()}>
              {bodyPhoto ? <img src={bodyPhoto} alt="body scale" style={s.photoPreview} /> : (
                <div style={s.photoPlaceholder}>
                  <span style={{ fontSize: 36 }}>⚖️</span>
                  <span style={{ color: "#888", fontSize: 13 }}>体組成計の画面を撮影</span>
                  <span style={{ color: "#666", fontSize: 11 }}>AIが自動で数値を読み取ります</span>
                </div>
              )}
              <input ref={bodyFileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleBodyPhoto} />
            </div>

            <button style={{ ...s.primaryBtn, opacity: analyzingBody ? 0.6 : 1 }} onClick={analyzeBodyPhoto} disabled={analyzingBody || !bodyPhotoBase64}>
              {analyzingBody ? "読み取り中..." : "🤖 AIで数値を読み取る"}
            </button>

            {bodyResult && !bodyResult.error && editingBody && (
              <div style={s.resultCard}>
                <p style={s.resultTitle}>📊 読み取り結果（修正可能）</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[
                    ["weight", "体重", "kg"],
                    ["bmi", "BMI", ""],
                    ["fatRate", "体脂肪率", "%"],
                    ["muscleMass", "除脂肪体重", "kg"],
                    ["bmr", "基礎代謝", "kcal"],
                    ["visceralFat", "内臓脂肪Lv", ""],
                    ["skeletalMuscleRate", "骨格筋率", "%"],
                    ["boneMass", "骨量", "kg"],
                    ["bodyWater", "体水分率", "%"],
                    ["bodyAge", "体内年齢", "歳"],
                  ].map(([key, label, unit]) => editingBody[key] != null ? (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: "#aaa", fontSize: 13, width: 90, flexShrink: 0 }}>{label}</span>
                      <input
                        style={{ ...s.weightInput, flex: 1, padding: "6px 10px", fontSize: 14 }}
                        type="number" step="0.1"
                        value={editingBody[key]}
                        onChange={e => setEditingBody(p => ({ ...p, [key]: +e.target.value }))}
                      />
                      <span style={{ color: "#888", fontSize: 13, width: 30 }}>{unit}</span>
                    </div>
                  ) : null)}
                </div>
                {bodyResult.notes && <p style={{ ...s.resultNotes, marginTop: 12 }}>💡 {bodyResult.notes}</p>}
                <button style={{ ...s.primaryBtn, marginTop: 12 }} onClick={saveBodyLog}>✅ 記録する</button>
              </div>
            )}
            {bodyResult?.error && <p style={{ color: "#f87171", textAlign: "center" }}>{bodyResult.error}</p>}

            {/* History */}
            {state.bodyLogs.length > 0 && (
              <div>
                <p style={{ ...s.sectionTitle, marginTop: 20 }}>体組成の履歴</p>
                {[...state.bodyLogs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10).map(log => (
                  <div key={log.date} style={s.historyCard}>
                    <p style={{ color: "#f97316", fontWeight: 700, margin: "0 0 8px" }}>{log.date}</p>
                    <div style={s.bodyGrid}>
                      {[["体重", log.weight, "kg"], ["体脂肪率", log.fatRate, "%"], ["骨格筋率", log.skeletalMuscleRate, "%"], ["基礎代謝", log.bmr, "kcal"]].filter(([, v]) => v != null).map(([l, v, u]) => (
                        <div key={l} style={s.bodyGridItem}><span style={s.bodyGridLabel}>{l}</span><span style={s.bodyGridVal}>{v}<span style={{ fontSize: 11, color: "#888" }}>{u}</span></span></div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* HISTORY */}
        {tab === "history" && (
          <div>
            <p style={s.sectionTitle}>記録履歴</p>
            {state.logs.length === 0 ? <p style={s.emptyText}>まだ記録がありません</p> : [...state.logs].reverse().map(log => {
              const dayTotal = log.meals.reduce((sum, m) => sum + (m.calories || 0), 0);
              const dayDef = targetCal - dayTotal;
              return (
                <div key={log.date} style={s.historyCard}>
                  <div style={s.historyHeader}>
                    <span style={s.historyDate}>{log.date}</span>
                    <span style={{ color: dayDef >= 0 ? "#4ade80" : "#f87171", fontWeight: 700 }}>{dayDef >= 0 ? `-${dayDef}` : `+${Math.abs(dayDef)}`} kcal</span>
                  </div>
                  <div style={s.historyMeta}><span>摂取: {dayTotal} kcal</span>{log.weight && <span>体重: {log.weight} kg</span>}</div>
                  {log.meals.map((m, i) => (
                    <div key={i} style={s.historyMeal}>
                      <span style={{ color: "#aaa", fontSize: 12 }}>{m.time} </span>
                      <span style={{ color: "#ddd", fontSize: 13 }}>{m.description || m.memo}</span>
                      <span style={{ color: "#f97316", fontSize: 12, marginLeft: "auto" }}>{m.calories}kcal</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div style={s.nav}>
        {[["🏠", "dashboard", "ホーム"], ["➕", "add", "食事"], ["⚖️", "body", "体組成"], ["📋", "history", "履歴"]].map(([icon, t, label]) => (
          <button key={t} style={{ ...s.navBtn, color: tab === t ? "#f97316" : "#666" }} onClick={() => setTab(t)}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <span style={{ fontSize: 9 }}>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const s = {
  app: { fontFamily: "'Noto Sans JP', sans-serif", background: "#111", minHeight: "100vh", maxWidth: 430, margin: "0 auto", display: "flex", flexDirection: "column", color: "#fff" },
  header: { display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #222", gap: 8 },
  headerTitle: { flex: 1, fontWeight: 700, fontSize: 18, letterSpacing: 1 },
  settingsBtn: { background: "none", border: "none", fontSize: 20, cursor: "pointer" },
  content: { flex: 1, padding: "12px 16px", overflowY: "auto", paddingBottom: 80 },
  nav: { position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, display: "flex", background: "#1a1a1a", borderTop: "1px solid #222" },
  navBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "10px 0", background: "none", border: "none", cursor: "pointer", gap: 2 },
  heroCard: { background: "linear-gradient(135deg, #1c1c1c, #252525)", border: "1px solid #333", borderRadius: 16, padding: 16, marginBottom: 12 },
  heroTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  heroLabel: { color: "#888", fontSize: 12, margin: "0 0 4px" },
  heroCalories: { fontSize: 36, fontWeight: 800, margin: 0 },
  heroUnit: { fontSize: 16, fontWeight: 400, color: "#888" },
  heroTarget: { color: "#888", fontSize: 12, margin: "4px 0 0" },
  deficitBadge: { display: "flex", flexDirection: "column", alignItems: "center", background: "#0f0f0f", borderRadius: 12, padding: "8px 12px" },
  progressBar: { height: 6, background: "#333", borderRadius: 99, overflow: "hidden", marginBottom: 12 },
  progressFill: { height: "100%", borderRadius: 99, transition: "width 0.5s" },
  pfcRow: { display: "flex", gap: 8 },
  pfcItem: { flex: 1, background: "#1a1a1a", borderRadius: 8, padding: "6px 0", textAlign: "center" },
  pfcLabel: { display: "block", fontSize: 10, fontWeight: 700, marginBottom: 2 },
  pfcVal: { display: "block", fontSize: 14, fontWeight: 600 },
  cumCard: { display: "flex", gap: 10, marginBottom: 12 },
  cumLeft: { flex: 1, background: "#1c1c1c", border: "1px solid #333", borderRadius: 12, padding: 12 },
  cumRight: { flex: 1, background: "#1c1c1c", border: "1px solid #333", borderRadius: 12, padding: 12 },
  cumLabel: { color: "#888", fontSize: 11, margin: "0 0 4px" },
  cumValue: { fontSize: 20, fontWeight: 700, margin: 0 },
  bodyCard: { background: "#1c1c1c", border: "1px solid #333", borderRadius: 12, padding: 14, marginBottom: 12 },
  bodyGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 },
  bodyGridItem: { background: "#111", borderRadius: 8, padding: "6px 8px" },
  bodyGridLabel: { display: "block", fontSize: 10, color: "#888", marginBottom: 2 },
  bodyGridVal: { display: "block", fontSize: 14, fontWeight: 700 },
  weightCard: { background: "#1c1c1c", border: "1px solid #333", borderRadius: 12, padding: 14, marginBottom: 12 },
  weightInputRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 },
  weightInput: { flex: 1, background: "#111", border: "1px solid #444", borderRadius: 8, padding: "8px 10px", color: "#fff", fontSize: 16 },
  weightList: { marginTop: 10 },
  weightRow: { display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #222" },
  weightDate: { color: "#888", fontSize: 13 },
  weightVal: { color: "#fff", fontWeight: 600 },
  mealsCard: { background: "#1c1c1c", border: "1px solid #333", borderRadius: 12, padding: 14 },
  mealRow: { display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #222" },
  mealLeft: { display: "flex", flexDirection: "column" },
  mealTime: { color: "#888", fontSize: 11 },
  mealDesc: { color: "#ddd", fontSize: 13 },
  mealRight: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  mealCal: { color: "#f97316", fontWeight: 700, fontSize: 14 },
  mealPfc: { color: "#888", fontSize: 11 },
  sectionTitle: { fontWeight: 700, fontSize: 16, marginBottom: 12, color: "#fff" },
  emptyText: { color: "#666", textAlign: "center", padding: "20px 0" },
  addContainer: { display: "flex", flexDirection: "column", gap: 12 },
  photoArea: { background: "#1a1a1a", border: "2px dashed #333", borderRadius: 12, height: 180, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", overflow: "hidden" },
  photoPlaceholder: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  photoPreview: { width: "100%", height: "100%", objectFit: "cover" },
  memo: { background: "#1a1a1a", border: "1px solid #333", borderRadius: 10, padding: 12, color: "#fff", fontSize: 14, resize: "none", fontFamily: "inherit" },
  resultCard: { background: "#1c1c1c", border: "1px solid #f97316", borderRadius: 12, padding: 14 },
  resultTitle: { fontWeight: 700, marginBottom: 10, color: "#f97316" },
  resultGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 },
  resultItem: { background: "#111", borderRadius: 8, padding: "8px 10px" },
  resultLabel: { display: "block", fontSize: 11, color: "#888", marginBottom: 2 },
  resultVal: { display: "block", fontWeight: 700, fontSize: 15 },
  resultNotes: { color: "#aaa", fontSize: 13, marginBottom: 0, lineHeight: 1.5 },
  historyCard: { background: "#1c1c1c", border: "1px solid #2a2a2a", borderRadius: 12, padding: 14, marginBottom: 10 },
  historyHeader: { display: "flex", justifyContent: "space-between", marginBottom: 6 },
  historyDate: { fontWeight: 700 },
  historyMeta: { display: "flex", gap: 16, color: "#888", fontSize: 13, marginBottom: 8 },
  historyMeal: { display: "flex", gap: 6, padding: "4px 0", alignItems: "center" },
  setupContainer: { minHeight: "100vh", background: "#111", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  setupCard: { background: "#1a1a1a", border: "1px solid #333", borderRadius: 20, padding: 28, width: "100%", maxWidth: 380 },
  setupTitle: { textAlign: "center", fontSize: 26, fontWeight: 800, margin: "0 0 6px" },
  setupSub: { textAlign: "center", color: "#888", fontSize: 14, marginBottom: 24 },
  field: { marginBottom: 18 },
  label: { display: "block", color: "#aaa", fontSize: 13, marginBottom: 6 },
  inputRow: { display: "flex", alignItems: "center", gap: 8 },
  input: { flex: 1, background: "#111", border: "1px solid #444", borderRadius: 8, padding: "10px 12px", color: "#fff", fontSize: 16 },
  unit: { color: "#888", fontSize: 14, whiteSpace: "nowrap" },
  hint: { color: "#f97316", fontSize: 12, marginTop: 6 },
  primaryBtn: { width: "100%", background: "#f97316", border: "none", borderRadius: 10, padding: "14px 0", color: "#fff", fontWeight: 700, fontSize: 16, cursor: "pointer", marginTop: 4 },
  smallBtn: { background: "#f97316", border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", fontWeight: 700, cursor: "pointer" },
};