import { useState, useEffect, useRef, useCallback } from "react";
import { 
  registerAccount, loginAccount, fetchAllAccounts, 
  updateAccount, deleteAccount, fetchKeys, addKey, 
  removeKey, validateKey 
} from './supabase.js';

// ─── PINK PALETTE ─────────────────────────────────────────────────────────────
const P = {
  deep:"#c2185b", hot:"#ff1493", soft:"#ff69b4", pale:"#ffb6c1",
  bg:"#0d050a", bgCard:"rgba(255,20,147,0.06)",
  border:"rgba(255,20,147,0.18)", glow:"rgba(255,20,147,0.35)",
  glowSm:"rgba(255,20,147,0.15)",
};

// ─── RISK TIERS ───────────────────────────────────────────────────────────────
const RISK_TIERS = [
  { label:"SAFE",     min:1.00, max:1.99, color:"#66bb6a", desc:"Low multiplier zone"   },
  { label:"MEDIUM",   min:2.00, max:3.99, color:"#ffb400", desc:"Mid multiplier zone"   },
  { label:"HIGH",     min:4.00, max:9.99, color:P.hot,     desc:"4x risk zone"          },
  { label:"EXTREME",  min:10.0, max:999,  color:"#ffd700", desc:"10x+ jackpot zone"     },
];
function getRiskTier(val) {
  return RISK_TIERS.find(t => val >= t.min && val < t.max) || RISK_TIERS[0];
}

// ─── PINK PROBABILITY ENGINE ──────────────────────────────────────────────────
// Analyses recent trends and time windows to compute a % chance of a pink
// (3x+) appearing on the NEXT round. Shows as a probability bar + time signal.
function calcPinkProbability(history, minute, second) {
  if (history.length < 5) return { prob: 0, trend: "neutral", timeSignal: null, factors: [] };

  const factors = [];
  let score = 0;

  // Factor 1: How long since last pink (3x+)
  const lastPinkIdx = history.findIndex(v => v >= 3.0);
  const droughtBonus = lastPinkIdx === -1 ? 30
    : lastPinkIdx === 0 ? -10
    : Math.min(35, lastPinkIdx * 6);
  score += droughtBonus;
  factors.push({ label: "Drought since last 3x+", value: lastPinkIdx === -1 ? "20+ rounds" : `${lastPinkIdx} rounds ago`, impact: droughtBonus });

  // Factor 2: Consecutive low rounds — pressure building
  let lowStreak = 0;
  for (const v of history) { if (v < 2.0) lowStreak++; else break; }
  const streakBonus = Math.min(25, lowStreak * 5);
  score += streakBonus;
  if (lowStreak > 0) factors.push({ label: "Low streak", value: `${lowStreak} consecutive <2x`, impact: streakBonus });

  // Factor 3: Average of last 5 rounds — low average = pink due
  const avg5 = history.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const avgBonus = avg5 < 2.0 ? 20 : avg5 < 3.0 ? 10 : avg5 > 5.0 ? -15 : 0;
  score += avgBonus;
  factors.push({ label: "5-round average", value: `${avg5.toFixed(2)}x`, impact: avgBonus });

  // Factor 4: Time window bonus
  const win = getTimeWindow(minute);
  const twBonus = win ? (win.priority === "HIGH" ? 25 : 15) : 0;
  score += twBonus;
  if (win) factors.push({ label: "Time window", value: win.name, impact: twBonus });

  // Factor 5: Pink clustering — if 2+ pinks in last 10, less likely now
  const recentPinks = history.slice(0, 10).filter(v => v >= 3.0).length;
  const clusterPenalty = recentPinks >= 3 ? -20 : recentPinks === 2 ? -10 : 0;
  score += clusterPenalty;
  if (clusterPenalty < 0) factors.push({ label: "Recent pink cluster", value: `${recentPinks} in last 10`, impact: clusterPenalty });

  // Factor 6: Variance — high variance = more unpredictable = higher pink chance
  const mean = history.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, history.length);
  const variance = history.slice(0, 10).reduce((a, b) => a + (b - mean) ** 2, 0) / Math.min(10, history.length);
  const varBonus = variance > 4 ? 10 : variance > 2 ? 5 : 0;
  score += varBonus;

  // Clamp probability 5–95%
  const prob = Math.max(5, Math.min(95, score));

  // Trend
  const trend = prob >= 70 ? "hot" : prob >= 45 ? "warm" : "cold";

  // Time signal — predict window when pink is most likely
  // Format: "HH:MM to HH:MM"
  let timeSignal = null;
  const now = new Date();
  if (prob >= 55) {
    // Estimate rounds until pink: lower score = more rounds needed
    const roundsAway = prob >= 75 ? 1 : prob >= 60 ? 2 : 4;
    const secsPerRound = 25; // avg Aviator round length
    const startSec = now.getTime() + roundsAway * secsPerRound * 1000;
    const endSec   = startSec + secsPerRound * 1000;
    const fmt = ts => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    };
    timeSignal = `${fmt(startSec)} – ${fmt(endSec)}`;
  }

  return { prob, trend, timeSignal, factors, avgPink: avg5 };
}

// ─── ML ENGINE ────────────────────────────────────────────────────────────────
const CONFIG = {
  PINK_THRESHOLD: 3.0,
  ML_SETTINGS: {
    SEQUENCE_LENGTH: 12,
    ENSEMBLE_WEIGHTS: { neuralNetwork:0.35, sequencePattern:0.30, markovChain:0.20, lstm:0.10, statisticalModel:0.05 },
  },
  INTERVAL_SETTINGS: { MIN_SPREAD:0.10, MAX_SPREAD:1.20, RISK_MULTIPLIER:1.1 },
  TIME_WINDOWS: [
    { start:55, end:57, priority:"HIGH",   name:"PRIME PINK", multiplier:1.9, pinkProbability:0.90 },
    { start:59, end:1,  priority:"HIGH",   name:"PRIME PINK", multiplier:1.9, pinkProbability:0.90 },
    { start:18, end:20, priority:"MEDIUM", name:"PINK ZONE",  multiplier:1.4, pinkProbability:0.70 },
    { start:27, end:29, priority:"MEDIUM", name:"PINK ZONE",  multiplier:1.4, pinkProbability:0.70 },
    { start:38, end:40, priority:"MEDIUM", name:"PINK ZONE",  multiplier:1.4, pinkProbability:0.70 },
    { start:43, end:45, priority:"MEDIUM", name:"PINK ZONE",  multiplier:1.4, pinkProbability:0.70 },
    { start:48, end:50, priority:"MEDIUM", name:"PINK ZONE",  multiplier:1.4, pinkProbability:0.70 },
  ],
};
function getTimeWindow(m) {
  for (const w of CONFIG.TIME_WINDOWS)
    if (w.start > w.end ? (m>=w.start||m<w.end) : (m>=w.start&&m<w.end)) return w;
  return null;
}
function statPredict(h) {
  const mean=h.reduce((a,b)=>a+b,0)/h.length;
  const std=Math.sqrt(h.reduce((a,b)=>a+(b-mean)**2,0)/h.length);
  const rMean=h.slice(0,4).reduce((a,b)=>a+b,0)/4;
  return {prediction:Math.max(1.05,mean*(rMean>mean?1.05:0.97)),confidence:Math.max(0.3,0.8-std*0.1)};
}
function markovPredict(h) {
  const b=v=>v<1.5?0:v<2?1:v<3?2:v<5?3:4;
  const t=Array.from({length:5},()=>new Array(5).fill(0));
  for(let i=1;i<h.length;i++) t[b(h[i])][b(h[i-1])]++;
  const row=t[b(h[0])],tot=row.reduce((a,x)=>a+x,0)||1;
  const pred=row.reduce((a,v,i)=>a+(v/tot)*[1.25,1.75,2.5,4,7][i],0);
  const ent=row.map(v=>v/tot).reduce((a,p)=>p>0?a-p*Math.log2(p):a,0);
  return {prediction:Math.max(1.05,pred),confidence:Math.max(0.3,1-ent/Math.log2(5))};
}
function seqPredict(h) {
  const s=h.slice(0,6).map(v=>v<1.5?"L":v<2.5?"M":v<5?"H":"X").join("");
  const map={LLLLL:2.2,MMMMM:2.8,HHHHH:1.8,LLLM:1.9,LLMM:2.1,MMMH:3.2,HHMM:2.2,XLLL:1.6,XXXX:3.5};
  const k=Object.keys(map).find(p=>s.startsWith(p));
  return {prediction:k?map[k]:h.slice(0,6).reduce((a,b)=>a+b,0)/6*0.95,confidence:k?0.70:0.45};
}
function neuralPredict(h) {
  const inp=h.slice(0,12).map(v=>Math.min(v/10,1));
  const w1=[0.3,-0.2,0.5,0.1,-0.3,0.4,0.2,-0.1,0.6,-0.4,0.3,0.2];
  const hid=Array.from({length:8},(_,i)=>Math.max(0,inp.slice(0,8).reduce((a,v,j)=>a+v*(w1[(i+j)%12]||0.1),0)));
  const out=hid.reduce((a,v,i)=>a+v*[0.4,-0.3,0.5,0.2,-0.2,0.6,-0.4,0.3][i],0);
  return {prediction:Math.max(1.05,Math.min(15,1.5+out*5))*(inp[0]-inp[3]>0?1.08:0.95),confidence:0.72};
}
function lstmPredict(h) {
  let c=0,hh=0;
  for(let i=Math.min(h.length,10)-1;i>=0;i--){
    const x=h[i]/10,sig=v=>1/(1+Math.exp(-v));
    c=c*sig(hh*0.3+x*0.7-0.5)+sig(hh*0.4+x*0.6)*Math.tanh(hh*0.2+x*0.8);
    hh=sig(hh*0.3+x*0.5)*Math.tanh(c);
  }
  return {prediction:Math.max(1.05,Math.min(12,1.5+hh*6)),confidence:0.60};
}
function runEnsemble(history,minute) {
  if(history.length<12) return null;
  const h=history.slice(0,12),W=CONFIG.ML_SETTINGS.ENSEMBLE_WEIGHTS;
  const models={neuralNetwork:neuralPredict(h),sequencePattern:seqPredict(h),markovChain:markovPredict(h),lstm:lstmPredict(h),statisticalModel:statPredict(h)};
  let tw=0,ww=0;
  for(const [k,m] of Object.entries(models)){const w=W[k]*m.confidence;tw+=m.prediction*w;ww+=w;}
  const ens=ww>0?tw/ww:1.5,conf=Object.values(models).reduce((a,m)=>a+m.confidence,0)/5;
  const preds=Object.values(models).map(m=>m.prediction);
  const spread=Math.max(CONFIG.INTERVAL_SETTINGS.MIN_SPREAD,Math.min(CONFIG.INTERVAL_SETTINGS.MAX_SPREAD,(Math.max(...preds)-Math.min(...preds))*0.5));
  const win=getTimeWindow(minute);
  const final=ens*(win?win.multiplier:1.0);
  const lower=Math.max(1.01,(final-spread)/CONFIG.INTERVAL_SETTINGS.RISK_MULTIPLIER);
  const upper=Math.min(20,(final+spread)*CONFIG.INTERVAL_SETTINGS.RISK_MULTIPLIER);
  const isPink=(history.slice(0,10).filter(v=>v>=3).length<=2&&history.findIndex(v=>v>=3)>3)||(win?.pinkProbability>0.8)||final>=3;
  return {prediction:Math.max(1.05,Math.min(20,final)),lower,upper,confidence:Math.min(0.95,conf),isPinkExpected:isPink,window:win,models};
}

// ─── CIRCULAR GAUGE ──────────────────────────────────────────────────────────
function CircularGauge({value,confidence}) {
  const r=110,cx=130,cy=130,circ=2*Math.PI*r,prog=Math.min(1,(value-1)/19);
  const toRad=d=>d*Math.PI/180;
  const arc=(radius,s,e)=>{
    const x1=cx+radius*Math.cos(toRad(s)),y1=cy+radius*Math.sin(toRad(s));
    const x2=cx+radius*Math.cos(toRad(e)),y2=cy+radius*Math.sin(toRad(e));
    return `M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}`;
  };
  return (
    <svg width="260" height="260" viewBox="0 0 260 260" style={{overflow:"visible"}}>
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <filter id="og"><feGaussianBlur stdDeviation="10" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <linearGradient id="ag" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#c2185b"/>
          <stop offset="100%" stopColor={P.hot}/>
        </linearGradient>
      </defs>
      <circle cx={cx} cy={cy} r="126" fill="none" stroke={P.glow} strokeWidth="2" opacity="0.4" filter="url(#og)"/>
      <path d={arc(r,135,405)} fill="none" stroke="rgba(255,20,147,0.08)" strokeWidth="14" strokeLinecap="round"/>
      <path d={arc(r,135,405)} fill="none" stroke="url(#ag)" strokeWidth="14" strokeLinecap="round"
        strokeDasharray={`${circ*0.75*prog} ${circ}`} filter="url(#glow)"
        style={{transition:"stroke-dasharray 0.9s ease"}}/>
      <circle cx={cx} cy={cy} r="96" fill="rgba(0,0,0,0.55)" stroke={P.border} strokeWidth="1"/>
      <circle cx={cx} cy={cy} r="89" fill={`${P.bg}ee`} stroke="rgba(255,20,147,0.08)" strokeWidth="1"/>
      <circle cx={cx} cy={cy} r="79" fill="none" stroke="rgba(255,20,147,0.12)" strokeWidth="2"
        strokeDasharray={`${confidence*490} 490`} strokeLinecap="round"/>
    </svg>
  );
}

// ─── PINK PROBABILITY CARD ────────────────────────────────────────────────────
function PinkProbabilityCard({history,minute,second}) {
  const {prob,trend,timeSignal,factors} = calcPinkProbability(history,minute,second);
  const [expanded,setExpanded] = useState(false);

  const trendColor = trend==="hot" ? P.hot : trend==="warm" ? "#ffb400" : P.soft;
  const trendLabel = trend==="hot" ? "🔥 HOT" : trend==="warm" ? "⚡ WARM" : "❄️ COLD";
  const barColor   = prob>=70 ? P.hot : prob>=45 ? "#ffb400" : "#ff69b4";

  return (
    <div style={{background:P.bgCard,border:`1px solid ${P.border}`,borderRadius:12,padding:14,marginBottom:14}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:18}}>🌸</span>
          <div>
            <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:10,fontWeight:700,color:P.hot,letterSpacing:2}}>PINK PROBABILITY</div>
            <div style={{fontSize:9,color:"#664455",letterSpacing:1}}>TREND ANALYSIS</div>
          </div>
        </div>
        <span style={{fontSize:11,fontWeight:700,color:trendColor}}>{trendLabel}</span>
      </div>

      {/* Big probability number */}
      <div style={{display:"flex",alignItems:"flex-end",gap:10,marginBottom:10}}>
        <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:48,fontWeight:700,
          color:barColor,textShadow:`0 0 20px ${barColor}88`,lineHeight:1,
          animation:prob>=70?"pinkPulse 1.5s infinite":"none"}}>
          {prob}%
        </div>
        <div style={{paddingBottom:6}}>
          <div style={{fontSize:10,color:"#664455",marginBottom:2}}>chance of 3x+</div>
          <div style={{fontSize:10,color:"#664455"}}>next round</div>
        </div>
      </div>

      {/* Probability bar */}
      <div style={{height:8,background:"rgba(255,20,147,0.1)",borderRadius:4,overflow:"hidden",marginBottom:10}}>
        <div style={{height:"100%",width:`${prob}%`,borderRadius:4,
          background:`linear-gradient(90deg,${P.deep},${barColor})`,
          transition:"width 0.8s ease",boxShadow:`0 0 8px ${barColor}66`}}/>
      </div>

      {/* Time signal — the "2:30 to 2:31" style display */}
      {timeSignal && (
        <div style={{background:"rgba(255,20,147,0.12)",border:`1px solid ${P.hot}`,
          borderRadius:10,padding:"10px 14px",marginBottom:10,textAlign:"center",
          animation:"pinkGlow 2s infinite"}}>
          <div style={{fontSize:9,color:"#884466",letterSpacing:2,marginBottom:4}}>PINK SIGNAL WINDOW</div>
          <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:22,fontWeight:700,
            color:P.hot,textShadow:`0 0 15px ${P.glow}`,letterSpacing:2}}>
            {timeSignal}
          </div>
          <div style={{fontSize:9,color:P.soft,marginTop:4,letterSpacing:1}}>
            EXPECTED HIGH MULTIPLIER ZONE
          </div>
        </div>
      )}

      {/* Risk tier bands */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:10}}>
        {RISK_TIERS.map(tier=>{
          const active = prob >= (tier.label==="SAFE"?0:tier.label==="MEDIUM"?35:tier.label==="HIGH"?60:80);
          return (
            <div key={tier.label} style={{
              background:active?`${tier.color}18`:"rgba(0,0,0,0.2)",
              border:`1px solid ${active?tier.color:"rgba(255,255,255,0.06)"}`,
              borderRadius:8,padding:"6px 10px",
              opacity:active?1:0.4,transition:"all 0.3s"
            }}>
              <div style={{fontSize:9,fontWeight:700,color:tier.color,letterSpacing:1}}>{tier.label}</div>
              <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:11,color:tier.color,marginTop:1}}>
                {tier.min}x{tier.max<999?` – ${tier.max}x`:`+`}
              </div>
              <div style={{fontSize:8,color:"#553344",marginTop:2}}>{tier.desc}</div>
            </div>
          );
        })}
      </div>

      {/* Trend factors toggle */}
      {factors.length>0 && (
        <>
          <button onClick={()=>setExpanded(e=>!e)} style={{background:"none",border:"none",
            color:"#664455",fontFamily:"'Courier New',monospace",fontSize:9,cursor:"pointer",
            padding:0,letterSpacing:1}}>
            {expanded?"▲ Hide":"▼ Show"} trend factors ({factors.length})
          </button>
          {expanded && (
            <div style={{marginTop:8}}>
              {factors.map((f,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",
                  padding:"5px 0",borderBottom:`1px solid ${P.border}33`,
                  fontSize:10,fontFamily:"'Courier New',monospace"}}>
                  <span style={{color:"#885566"}}>{f.label}</span>
                  <span style={{color:P.soft}}>{f.value}</span>
                  <span style={{color:f.impact>0?P.hot:f.impact<0?"#ff4444":"#664455",
                    minWidth:32,textAlign:"right"}}>
                    {f.impact>0?"+":""}{f.impact}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── TERMINAL LOG ─────────────────────────────────────────────────────────────
const SCAN_MSGS=[">> Scanning live patterns for Aviator...",">> Fetching multiplier seed...",">> Calculating probability matrix...",">> Running neural ensemble v8.0...",">> Markov chain transition computed...",">> LSTM memory state updated...",">> Time window analysis complete...",">> Signal confidence calibrated...",">> Pattern memory boost applied...",">> Prediction interval locked..."];
function TerminalLog({lines}) {
  const ref=useRef(null);
  useEffect(()=>{if(ref.current) ref.current.scrollTop=ref.current.scrollHeight;},[lines]);
  return (
    <div ref={ref} style={{background:"rgba(20,0,10,0.85)",border:`1px solid ${P.border}`,borderRadius:10,
      padding:"12px 14px",fontFamily:"'Courier New',monospace",fontSize:11,color:P.soft,
      lineHeight:1.8,maxHeight:90,overflowY:"auto",scrollbarWidth:"none"}}>
      {lines.map((l,i)=>(
        <div key={i} style={{opacity:i===lines.length-1?1:0.45}}>
          {l}{i===lines.length-1&&<span style={{animation:"blink 1s infinite",display:"inline-block"}}>▌</span>}
        </div>
      ))}
    </div>
  );
}

// ─── VOICE INPUT ──────────────────────────────────────────────────────────────
// Fully functional Web Speech API integration.
// Works on Chrome/Kiwi/Firefox. The mic button is a proper <button> element
// with an onClick handler — not decorative. Recognised speech is parsed both
// as digits ("3.20") and as English words ("three point two zero").
function VoiceCrashInput({onAdd}) {
  const [inputVal,  setInputVal]  = useState("");
  const [feedback,  setFeedback]  = useState("");
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recRef = useRef(null);

  // Detect API support once on mount
  useEffect(()=>{
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSupported(!!SR);
  },[]);

  const wordsToNumber = (text) => {
    const wm={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
      ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
      sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20};
    // Try direct parse first ("3.20", "320", "3 20")
    const cleaned = text.trim().replace(/\s+/g,"").replace(",",".");
    const direct  = parseFloat(cleaned);
    if (!isNaN(direct) && direct >= 1.0) return direct;
    // Word parse: "three point two zero" → 3.20
    const parts = text.toLowerCase().replace(/[^a-z0-9.\s]/g,"").split(/\s+/);
    let left="", right="", inDec=false;
    for (const w of parts) {
      if (w==="point"||w==="dot"||w===".") { inDec=true; continue; }
      const d = wm[w];
      if (d !== undefined) { inDec ? (right+=d) : (left+=d); }
      else if (/^\d+$/.test(w)) { inDec ? (right+=w) : (left+=w); }
    }
    if (left) {
      const result = parseFloat(left + (right ? "."+right : ""));
      if (!isNaN(result) && result >= 1.0) return result;
    }
    return NaN;
  };

  const startListening = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setFeedback("Voice not supported on this browser"); return; }
    try {
      const rec = new SR();
      rec.lang           = "en-US";
      rec.continuous     = false;
      rec.interimResults = false;
      rec.maxAlternatives= 5;

      rec.onstart  = () => { setListening(true); setFeedback("🎙 Listening…"); };
      rec.onend    = () => { setListening(false); };
      rec.onerror  = (e) => {
        setListening(false);
        setFeedback(`Error: ${e.error}. Try again.`);
        setTimeout(()=>setFeedback(""),3000);
      };
      rec.onresult = (e) => {
        const results = e.results[0];
        for (let i=0; i<results.length; i++) {
          const phrase = results[i].transcript;
          const num    = wordsToNumber(phrase);
          if (!isNaN(num) && num>=1.0 && num<=200) {
            onAdd(num);
            setFeedback(`✔ Added ${num.toFixed(2)}x — heard "${phrase}"`);
            setTimeout(()=>setFeedback(""),3000);
            return;
          }
        }
        // Nothing parsed
        const heard = results[0].transcript;
        setFeedback(`Heard "${heard}" — say a number e.g. "two point four seven"`);
        setTimeout(()=>setFeedback(""),4000);
      };

      recRef.current = rec;
      rec.start();
    } catch(err) {
      setFeedback("Could not start voice. Try manual input.");
      setListening(false);
    }
  };

  const stopListening = () => {
    recRef.current?.stop();
    setListening(false);
    setFeedback("");
  };

  const handleManualAdd = () => {
    const v = parseFloat(inputVal);
    if (!isNaN(v) && v>=1.0) {
      onAdd(v);
      setInputVal("");
      setFeedback(`✔ Added ${v.toFixed(2)}x`);
      setTimeout(()=>setFeedback(""),2000);
    }
  };

  return (
    <div style={{marginBottom:14}}>
      <div style={{fontSize:9,color:"#664455",letterSpacing:2,marginBottom:6,fontWeight:700}}>ENTER CRASH VALUE</div>
      <div style={{display:"flex",gap:8,alignItems:"stretch"}}>
        {/* Number input */}
        <input type="number" step="0.01" min="1" value={inputVal}
          onChange={e=>setInputVal(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&handleManualAdd()}
          placeholder="e.g. 2.47"
          style={{flex:1,background:"rgba(255,20,147,0.07)",border:`1px solid ${P.border}`,
            borderRadius:10,padding:"12px 14px",color:"#f0d0e0",
            fontFamily:"'Courier New',monospace",fontSize:16,outline:"none"}}
          onFocus={e=>e.target.style.borderColor=P.hot}
          onBlur={e=>e.target.style.borderColor=P.border}
        />
        {/* ADD button */}
        <button
          onClick={handleManualAdd}
          style={{padding:"12px 16px",background:`linear-gradient(135deg,${P.deep},${P.hot})`,
            border:"none",borderRadius:10,color:"white",fontWeight:700,cursor:"pointer",
            fontSize:12,fontFamily:"'Rajdhani',sans-serif",letterSpacing:1,
            boxShadow:`0 2px 10px ${P.glowSm}`}}>
          ADD
        </button>
        {/* MIC button — only shown when speech API is available */}
        {supported && (
          <button
            onClick={listening ? stopListening : startListening}
            style={{
              width:46,height:46,borderRadius:10,flexShrink:0,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,
              border:`2px solid ${listening ? P.hot : P.border}`,
              background: listening ? `rgba(255,20,147,0.3)` : `rgba(255,20,147,0.10)`,
              boxShadow: listening ? `0 0 18px ${P.glow}` : "none",
              animation: listening ? "micPulse 1s infinite" : "none",
              transition:"all 0.2s",
            }}>
            {listening ? "⏹" : "🎙"}
          </button>
        )}
      </div>

      {/* Feedback strip */}
      {feedback && (
        <div style={{marginTop:8,padding:"7px 12px",borderRadius:8,
          background: feedback.startsWith("✔") ? "rgba(0,200,80,0.1)" : "rgba(255,20,147,0.08)",
          border:`1px solid ${feedback.startsWith("✔") ? "rgba(0,200,80,0.3)" : P.border}`,
          fontFamily:"'Courier New',monospace",fontSize:10,
          color: feedback.startsWith("✔") ? "#66bb6a" : P.pale,
          display:"flex",alignItems:"center",gap:6}}>
          {listening && <span style={{animation:"blink 0.8s infinite",color:P.hot,fontSize:12}}>●</span>}
          {feedback}
        </div>
      )}

      {/* Helper text when mic not supported */}
      {!supported && (
        <div style={{marginTop:6,fontSize:9,color:"#553344",fontFamily:"'Courier New',monospace"}}>
          Voice input not available — use Kiwi or Firefox browser for mic support
        </div>
      )}
    </div>
  );
}

// ─── KEY GENERATOR ────────────────────────────────────────────────────────────
function generateKey(){
  const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let k="AVBOT-";
  for(let i=0;i<8;i++) k+=c[Math.floor(Math.random()*c.length)];
  return k;
}

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
const ADMIN_PASS="Chris2008";
function AdminPanel({onClose}) {
  const [step,setStep]=useState("lock");
  const [passInput,setPassInput]=useState("");
  const [passError,setPassError]=useState("");
  const [accounts,setAccounts]=useState([]);
  const [activeTab,setActiveTab]=useState("accounts");
  const [keys,setKeys]=useState([]);
  const [newKey,setNewKey]=useState("");
  const [searchQ,setSearchQ]=useState("");
  const [toast,setToast]=useState("");
  const [loading,setLoading]=useState(false);

  const showToast=msg=>{setToast(msg);setTimeout(()=>setToast(""),2500);};

  const loadData=async()=>{
    setLoading(true);
    const {data:accs}=await fetchAllAccounts();
    const {data:ks}=await fetchKeys();
    setAccounts(accs||[]);
    setKeys((ks||[]).map(k=>k.key));
    setLoading(false);
  };

  const handleUnlock=async()=>{
    if(passInput===ADMIN_PASS){setStep("panel");setPassError("");loadData();}
    else{setPassError("Incorrect passcode.");setPassInput("");}
  };
  const toggleActive=async(id)=>{
    const acc=accounts.find(a=>a.id===id);
    const {data}=await updateAccount(id,{active:!acc.active});
    if(data){
      setAccounts(prev=>prev.map(a=>a.id===id?{...a,active:!a.active}:a));
      showToast(`${acc.name} ${!acc.active?"activated":"deactivated"}.`);
    }
  };
  const deleteAcc=async(id)=>{
    const acc=accounts.find(a=>a.id===id);
    if(!window.confirm(`Delete ${acc?.name}?`)) return;
    const {error}=await deleteAccount(id);
    if(!error){setAccounts(prev=>prev.filter(a=>a.id!==id));showToast("Account deleted.");}
  };
  const updateKey=async(id,key)=>{
    await updateAccount(id,{key});
    setAccounts(prev=>prev.map(a=>a.id===id?{...a,key}:a));
  };
  const handleAddKey=async()=>{
    const k=newKey.trim()||generateKey();
    const {error}=await addKey(k);
    if(!error){setKeys(prev=>[...prev,k]);showToast(`Key ${k} added.`);}
    setNewKey("");
  };
  const handleRemoveKey=async(k)=>{
    await removeKey(k);
    setKeys(prev=>prev.filter(x=>x!==k));
    showToast(`Key ${k} removed.`);
  };
  const copyKey=k=>{navigator.clipboard?.writeText(k);showToast(`Copied: ${k}`);};
  const filtered=accounts.filter(a=>(a.name||"").toLowerCase().includes(searchQ.toLowerCase())||(a.phone||"").includes(searchQ));

  const card={background:P.bgCard,border:`1px solid ${P.border}`,borderRadius:12,padding:16};
  const pinkBtn=(txt,onClick,small=false)=>(
    <button onClick={onClick} style={{padding:small?"5px 12px":"8px 16px",
      background:`linear-gradient(135deg,${P.deep},${P.hot})`,border:"none",borderRadius:8,
      color:"white",fontWeight:700,fontSize:small?10:12,cursor:"pointer",
      fontFamily:"'Rajdhani',sans-serif",letterSpacing:1,whiteSpace:"nowrap",
      boxShadow:`0 2px 10px ${P.glowSm}`}}>{txt}</button>
  );
  const ghostBtn=(txt,onClick,color=P.pale)=>(
    <button onClick={onClick} style={{padding:"5px 10px",background:"rgba(255,20,147,0.08)",
      border:`1px solid ${P.border}`,borderRadius:7,color,fontWeight:700,fontSize:10,
      cursor:"pointer",fontFamily:"'Rajdhani',sans-serif",whiteSpace:"nowrap"}}>{txt}</button>
  );

  if(step==="lock") return (
    <div style={{position:"fixed",inset:0,background:"rgba(13,5,10,0.97)",display:"flex",
      alignItems:"center",justifyContent:"center",zIndex:9999,fontFamily:"'Rajdhani',sans-serif"}}>
      <div style={{...card,width:"100%",maxWidth:360,textAlign:"center",padding:32}}>
        <div style={{fontSize:36,marginBottom:12}}>🔐</div>
        <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:16,color:P.hot,fontWeight:700,marginBottom:4}}>ADMIN ACCESS</div>
        <div style={{fontSize:12,color:"#885566",marginBottom:24}}>Enter admin passcode to continue</div>
        <input type="password" value={passInput} onChange={e=>setPassInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&handleUnlock()} placeholder="Enter passcode"
          style={{width:"100%",background:"rgba(255,20,147,0.07)",border:`1px solid ${P.border}`,
            borderRadius:10,padding:"13px 16px",color:"#f0d0e0",fontSize:15,textAlign:"center",
            fontFamily:"'Courier New',monospace",outline:"none",boxSizing:"border-box",marginBottom:10}}
          onFocus={e=>e.target.style.borderColor=P.hot}
          onBlur={e=>e.target.style.borderColor=P.border}
        />
        {passError&&<div style={{color:"#ff6b8a",fontSize:12,marginBottom:10}}>{passError}</div>}
        <div style={{display:"flex",gap:8}}>
          {pinkBtn("Unlock",handleUnlock)}
          <button onClick={onClose} style={{flex:1,padding:"8px",background:"rgba(255,20,147,0.07)",
            border:`1px solid ${P.border}`,borderRadius:8,color:P.pale,fontWeight:700,
            fontSize:12,cursor:"pointer",fontFamily:"'Rajdhani',sans-serif"}}>Cancel</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(13,5,10,0.98)",overflowY:"auto",
      zIndex:9999,fontFamily:"'Rajdhani',sans-serif",padding:"0 0 40px"}}>
      {toast&&(
        <div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",
          background:`linear-gradient(135deg,${P.deep},${P.hot})`,color:"white",
          padding:"10px 24px",borderRadius:24,fontSize:12,fontWeight:700,
          boxShadow:`0 4px 20px ${P.glow}`,zIndex:10000,letterSpacing:1}}>{toast}</div>
      )}
      <div style={{maxWidth:600,margin:"0 auto",padding:"20px 16px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
          <div>
            <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:9,letterSpacing:3,color:P.soft,marginBottom:4}}>AVIATOR SIGNAL BOT</div>
            <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:20,fontWeight:700,color:P.hot}}>ADMIN PANEL</div>
          </div>
          <button onClick={onClose} style={{padding:"8px 16px",background:"rgba(255,20,147,0.1)",
            border:`1px solid ${P.border}`,borderRadius:8,color:P.pale,fontWeight:700,
            fontSize:12,cursor:"pointer",fontFamily:"'Rajdhani',sans-serif"}}>✕ Close</button>
        </div>
        {loading && (
          <div style={{textAlign:"center",padding:"20px",color:P.soft,
            fontFamily:"'Courier New',monospace",fontSize:12}}>
            Loading data...
          </div>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:20}}>
          {[{label:"Total",value:accounts.length,icon:"👥"},{label:"Active",value:accounts.filter(a=>a.active).length,icon:"✅"},{label:"Inactive",value:accounts.filter(a=>!a.active).length,icon:"🚫"}].map(({label,value,icon})=>(
            <div key={label} style={{...card,textAlign:"center",padding:12}}>
              <div style={{fontSize:20,marginBottom:4}}>{icon}</div>
              <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:20,fontWeight:700,color:P.hot}}>{value}</div>
              <div style={{fontSize:9,color:"#664455",letterSpacing:1,marginTop:2}}>{label}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",background:"rgba(255,20,147,0.06)",borderRadius:10,padding:4,marginBottom:16,gap:4}}>
          {[["accounts","👥 Accounts"],["keys","🔑 Keys"]].map(([k,label])=>(
            <button key={k} onClick={()=>setActiveTab(k)} style={{flex:1,padding:"9px",border:"none",
              borderRadius:7,cursor:"pointer",fontFamily:"'Rajdhani',sans-serif",fontSize:12,fontWeight:700,
              background:activeTab===k?`linear-gradient(135deg,${P.deep},${P.hot})`:"transparent",
              color:activeTab===k?"white":"#664455"}}>{label}</button>
          ))}
        </div>
        {activeTab==="accounts"&&(
          <div>
            <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Search by name or phone…"
              style={{width:"100%",background:"rgba(255,20,147,0.07)",border:`1px solid ${P.border}`,
                borderRadius:10,padding:"11px 14px",color:"#f0d0e0",fontSize:13,outline:"none",
                fontFamily:"'Rajdhani',sans-serif",boxSizing:"border-box",marginBottom:14}}
              onFocus={e=>e.target.style.borderColor=P.hot}
              onBlur={e=>e.target.style.borderColor=P.border}
            />
            {filtered.map(acc=>(
              <div key={acc.id} style={{...card,marginBottom:12,position:"relative"}}>
                <div style={{position:"absolute",left:0,top:0,bottom:0,width:4,borderRadius:"12px 0 0 12px",
                  background:acc.active?P.hot:"#333"}}/>
                <div style={{paddingLeft:12}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:10}}>
                    <div>
                      <div style={{fontSize:15,fontWeight:700,color:"#f8e0e8",marginBottom:2}}>{acc.name}</div>
                      <div style={{fontSize:11,color:"#885566",fontFamily:"'Courier New',monospace"}}>{acc.phone}</div>
                    </div>
                    <span style={{fontSize:9,fontWeight:700,letterSpacing:2,padding:"3px 8px",borderRadius:20,
                      background:acc.active?"rgba(255,20,147,0.2)":"rgba(100,0,50,0.2)",
                      color:acc.active?P.hot:"#664455"}}>{acc.active?"ACTIVE":"INACTIVE"}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,
                    background:"rgba(255,20,147,0.05)",borderRadius:8,padding:"6px 10px"}}>
                    <span style={{fontSize:10,color:"#664455",flexShrink:0}}>Key:</span>
                    <select value={acc.key} onChange={e=>updateKey(acc.id,e.target.value)}
                      style={{flex:1,background:"transparent",border:`1px solid ${P.border}`,borderRadius:6,
                        padding:"4px 8px",color:P.soft,fontFamily:"'Courier New',monospace",fontSize:11,cursor:"pointer",outline:"none"}}>
                      {keys.map(k=><option key={k} value={k} style={{background:"#1a0510"}}>{k}</option>)}
                    </select>
                    <button onClick={()=>copyKey(acc.key)} style={{fontSize:14,background:"none",border:"none",cursor:"pointer"}}>📋</button>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {pinkBtn(acc.active?"🚫 Deactivate":"✅ Activate",()=>toggleActive(acc.id),true)}
                    {ghostBtn("🗑 Delete",()=>deleteAcc(acc.id),"#ff6b8a")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {activeTab==="keys"&&(
          <div>
            <div style={{...card,marginBottom:14}}>
              <div style={{fontSize:10,letterSpacing:3,color:"#664455",marginBottom:12,fontWeight:700}}>GENERATE NEW KEY</div>
              <div style={{display:"flex",gap:8}}>
                <input value={newKey} onChange={e=>setNewKey(e.target.value)} placeholder="Custom or leave blank to auto-generate"
                  style={{flex:1,background:"rgba(255,20,147,0.07)",border:`1px solid ${P.border}`,
                    borderRadius:10,padding:"10px 14px",color:"#f0d0e0",fontSize:12,outline:"none",
                    fontFamily:"'Courier New',monospace"}}
                  onFocus={e=>e.target.style.borderColor=P.hot}
                  onBlur={e=>e.target.style.borderColor=P.border}
                />
                {pinkBtn("+ Generate",addKey)}
              </div>
            </div>
            <div style={{fontSize:10,letterSpacing:3,color:"#664455",marginBottom:10,fontWeight:700}}>ACTIVE KEYS ({keys.length})</div>
            {keys.map(k=>{
              const assignedTo=accounts.filter(a=>a.key===k).map(a=>a.name);
              return (
                <div key={k} style={{...card,marginBottom:10,display:"flex",alignItems:"center",gap:10}}>
                  <div style={{flex:1}}>
                    <div style={{fontFamily:"'Courier New',monospace",fontSize:13,fontWeight:700,color:P.soft,marginBottom:3}}>{k}</div>
                    <div style={{fontSize:10,color:"#664455"}}>{assignedTo.length>0?`Used by: ${assignedTo.join(", ")}`:"Not assigned"}</div>
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    {ghostBtn("📋 Copy",()=>copyKey(k))}
                    {ghostBtn("🗑",()=>handleRemoveKey(k),"#ff6b8a")}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AUTH FIELD — defined outside AuthScreen so it never remounts on re-render
// (mounting inside the parent caused focus loss after every keystroke on mobile)
function AuthField({label,value,onChange,type="text",placeholder}) {
  return (
    <div style={{marginBottom:16}}>
      <div style={{marginBottom:6}}>
        <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:10,fontWeight:700,letterSpacing:2,color:P.pale}}>{label}</span>
      </div>
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        style={{width:"100%",background:"rgba(255,20,147,0.06)",border:`1px solid ${P.border}`,
          borderRadius:10,padding:"13px 16px",color:"#f0d0e0",fontSize:14,
          fontFamily:"'Rajdhani',sans-serif",outline:"none",boxSizing:"border-box"}}
        onFocus={e=>e.target.style.borderColor=P.hot}
        onBlur={e=>e.target.style.borderColor=P.border}
      />
    </div>
  );
}

// ─── AUTH SCREEN ──────────────────────────────────────────────────────────────
function AuthScreen({onLogin}) {
  const [tab,setTab]=useState("register");
  const [reg,setReg]=useState({name:"",phone:"",password:"",key:""});
  const [log,setLog]=useState({phone:"",password:""});
  const [err,setErr]=useState("");

  const [busy,setBusy]=useState(false);

  const handleRegister=async()=>{
    if(!reg.name||!reg.phone||!reg.password){setErr("Please fill all required fields.");return;}
    setBusy(true);setErr("");
    // Validate key if provided
    if(reg.key){
      const valid=await validateKey(reg.key);
      if(!valid){setErr("Invalid access key.");setBusy(false);return;}
    }
    const {data,error}=await registerAccount({
      name:reg.name,phone:reg.phone,password:reg.password,key:reg.key||"AVBOT2025"
    });
    setBusy(false);
    if(error){
      if(error.code==="23505") setErr("Phone number already registered.");
      else setErr("Registration failed. Please try again.");
      return;
    }
    onLogin(data);
  };

  const handleLogin=async()=>{
    if(!log.phone||!log.password){setErr("Please fill all fields.");return;}
    setBusy(true);setErr("");
    const {data,error}=await loginAccount({phone:log.phone,password:log.password});
    setBusy(false);
    if(error||!data){setErr("Invalid phone or password.");return;}
    if(!data.active){setErr("Account deactivated. Contact admin.");return;}
    onLogin(data);
  };

  return (
    <div style={{minHeight:"100vh",background:`linear-gradient(160deg,${P.bg} 0%,#150510 60%,${P.bg} 100%)`,
      display:"flex",justifyContent:"center",fontFamily:"'Rajdhani',sans-serif"}}>
      <div style={{width:"100%",maxWidth:480}}>
        <div style={{background:`linear-gradient(135deg,rgba(194,24,91,0.35),rgba(80,0,40,0.6))`,
          border:`1px solid ${P.border}`,borderRadius:"0 0 22px 22px",
          padding:"20px 24px",marginBottom:24,display:"flex",alignItems:"center",gap:14}}>
          <div style={{width:52,height:52,background:`linear-gradient(135deg,${P.deep},${P.hot})`,
            borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:13,fontWeight:800,color:"white",letterSpacing:1}}>ASB</div>
          <div>
            <div style={{fontSize:18,fontWeight:700,color:"#f8e0e8"}}>Aviator Signal Bot</div>
            <div style={{fontSize:11,color:P.soft,letterSpacing:1}}>Premium access</div>
          </div>
        </div>
        <div style={{padding:"0 20px"}}>
          <div style={{display:"flex",background:"rgba(255,20,147,0.06)",borderRadius:12,padding:4,marginBottom:24,gap:4}}>
            {["login","register"].map(t=>(
              <button key={t} onClick={()=>{setTab(t);setErr("");}} style={{flex:1,padding:"10px",border:"none",
                borderRadius:9,cursor:"pointer",fontFamily:"'Rajdhani',sans-serif",fontSize:13,fontWeight:700,
                letterSpacing:1,textTransform:"capitalize",
                background:tab===t?`linear-gradient(135deg,${P.deep},${P.hot})`:"transparent",
                color:tab===t?"white":"#664455"}}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>
            ))}
          </div>
          {tab==="register"?(
            <>
              <div style={{fontSize:28,fontWeight:700,color:"#f8e0e8",marginBottom:4}}>Register</div>
              <div style={{fontSize:13,color:"#885566",marginBottom:24,lineHeight:1.5}}>Create your account to access premium signals.</div>
              <AuthField label="FULL NAME"    value={reg.name}     onChange={v=>setReg(r=>({...r,name:v}))}     placeholder="Your full name"/>
              <AuthField label="PHONE NUMBER" value={reg.phone}    onChange={v=>setReg(r=>({...r,phone:v}))}    placeholder="07XXXXXXXX"/>
              <AuthField label="PASSWORD" type="password" value={reg.password} onChange={v=>setReg(r=>({...r,password:v}))} placeholder="Create password"/>
              <AuthField label="ACCESS KEY"   value={reg.key}      onChange={v=>setReg(r=>({...r,key:v}))}      placeholder="Enter access key (AVBOT2025)"/>
              {err&&<div style={{color:"#ff6b8a",fontSize:12,marginBottom:12,padding:"8px 12px",
                background:"rgba(255,20,70,0.1)",borderRadius:8}}>{err}</div>}
              <button onClick={handleRegister} style={{width:"100%",padding:"15px",
                background:`linear-gradient(135deg,${P.deep},${P.hot})`,border:"none",borderRadius:12,
                color:"white",fontSize:15,fontWeight:700,fontFamily:"'Rajdhani',sans-serif",
                letterSpacing:1,cursor:"pointer",marginBottom:12,boxShadow:`0 4px 20px ${P.glow}`}}>
                Register Now
              </button>
              <button onClick={()=>setReg({name:"",phone:"",password:"",key:""})}
                style={{width:"100%",padding:"13px",background:"rgba(255,20,147,0.07)",
                  border:`1px solid ${P.border}`,borderRadius:12,color:P.pale,
                  fontSize:13,fontWeight:600,fontFamily:"'Rajdhani',sans-serif",cursor:"pointer"}}>Clear</button>
              <div style={{fontSize:11,color:"#553344",textAlign:"center",marginTop:20,lineHeight:1.6}}>
                Register first. After activation login with your phone and password.
              </div>
            </>
          ):(
            <>
              <div style={{fontSize:28,fontWeight:700,color:"#f8e0e8",marginBottom:4}}>Login</div>
              <div style={{fontSize:13,color:"#885566",marginBottom:24}}>Access your premium signals.</div>
              <AuthField label="PHONE NUMBER" value={log.phone}    onChange={v=>setLog(l=>({...l,phone:v}))}    placeholder="07XXXXXXXX"/>
              <AuthField label="PASSWORD" type="password" value={log.password} onChange={v=>setLog(l=>({...l,password:v}))} placeholder="Your password"/>
              {err&&<div style={{color:"#ff6b8a",fontSize:12,marginBottom:12}}>{err}</div>}
              <button onClick={handleLogin} style={{width:"100%",padding:"15px",
                background:`linear-gradient(135deg,${P.deep},${P.hot})`,border:"none",borderRadius:12,
                color:"white",fontSize:15,fontWeight:700,fontFamily:"'Rajdhani',sans-serif",
                letterSpacing:1,cursor:"pointer",boxShadow:`0 4px 20px ${P.glow}`}}>{busy?"Logging in...":"Login"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── NAV BAR ──────────────────────────────────────────────────────────────────
function NavBar({page,setPage,onAdmin}) {
  const items=[{key:"signals",icon:"📡",label:"Signals"},{key:"analyzer",icon:"📊",label:"Analyzer"},{key:"dashboard",icon:"⊞",label:"Dashboard"},{key:"profile",icon:"👤",label:"Profile"}];
  return (
    <div style={{display:"flex",justifyContent:"space-around",alignItems:"center",
      borderBottom:`1px solid ${P.border}`,paddingBottom:12,marginBottom:20}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginRight:"auto"}}>
        <span style={{fontSize:20}}>✈️</span>
        <div>
          <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:11,fontWeight:700,color:P.hot,lineHeight:1}}>AVIATOR</div>
          <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:11,fontWeight:700,color:P.hot,lineHeight:1}}>SIGNAL BOT</div>
        </div>
        <div onClick={onAdmin} style={{marginLeft:6,background:"rgba(255,20,147,0.2)",border:`1px solid ${P.hot}55`,
          borderRadius:20,padding:"2px 7px",fontSize:9,color:P.hot,fontWeight:700,cursor:"pointer"}}>9+</div>
      </div>
      {items.map(it=>(
        <button key={it.key} onClick={()=>setPage(it.key)} style={{background:"none",border:"none",cursor:"pointer",
          display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"4px 8px",
          borderBottom:page===it.key?`2px solid ${P.hot}`:"2px solid transparent"}}>
          <span style={{fontSize:16}}>{it.icon}</span>
          <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:10,fontWeight:600,
            color:page===it.key?P.hot:"#664455"}}>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

// ─── SIGNAL SCREEN ────────────────────────────────────────────────────────────
const DEMO_HISTORY=[2.1,1.3,5.7,1.8,3.2,1.1,2.9,4.4,1.6,2.3,1.9,3.8,2.7,1.4,6.1,2.0,1.7,3.3,1.2,2.8];

function SignalScreen({user,onAdmin}) {
  const [history,   setHistory]   = useState(DEMO_HISTORY);
  const [signal,    setSignal]    = useState(null);
  const [page,      setPage]      = useState("signals");
  const [time,      setTime]      = useState(new Date());
  const [termLines, setTermLines] = useState([SCAN_MSGS[0]]);
  const [lineIdx,   setLineIdx]   = useState(1);
  const [generating,setGenerating]= useState(false);
  const [signalTime,setSignalTime]= useState(new Date());

  useEffect(()=>{ const t=setInterval(()=>setTime(new Date()),1000); return()=>clearInterval(t); },[]);

  useEffect(()=>{
    if(!generating) return;
    if(lineIdx>=SCAN_MSGS.length){setGenerating(false);return;}
    const t=setTimeout(()=>{setTermLines(prev=>[...prev.slice(-6),SCAN_MSGS[lineIdx]]);setLineIdx(i=>i+1);},380+Math.random()*280);
    return()=>clearTimeout(t);
  },[generating,lineIdx]);

  const generateSignal=useCallback(()=>{
    setGenerating(true);setTermLines([SCAN_MSGS[0]]);setLineIdx(1);
    const r=runEnsemble(history,new Date().getMinutes());
    setSignal(r);setSignalTime(new Date());
  },[history]);

  const handleAddCrash=useCallback(num=>{
    setHistory(prev=>{
      const next=[num,...prev].slice(0,1000);
      setSignal(runEnsemble(next,new Date().getMinutes()));
      setSignalTime(new Date());
      return next;
    });
  },[]);

  useEffect(()=>{generateSignal();},[]);

  const timeStr=time.toLocaleTimeString("en-US",{hour12:false});
  const sigTimeStr=signalTime.toLocaleTimeString("en-US",{hour12:false});
  const conf=signal?Math.round(signal.confidence*100):72;
  const riskTier=getRiskTier(signal?.prediction||2.0);

  return (
    <div style={{minHeight:"100vh",background:`linear-gradient(160deg,${P.bg} 0%,#120408 60%,${P.bg} 100%)`,
      fontFamily:"'Rajdhani',sans-serif",color:"#f0d0e0",display:"flex",justifyContent:"center"}}>
      <div style={{width:"100%",maxWidth:480,padding:"16px 16px 40px"}}>
        <NavBar page={page} setPage={setPage} onAdmin={onAdmin}/>

        {/* ── SIGNALS TAB ── */}
        {page==="signals"&&(
          <>
            <div style={{fontSize:11,color:P.hot,letterSpacing:2,fontWeight:600,marginBottom:4}}>✈ AVIATOR SIGNAL BOT</div>
            <div style={{fontSize:28,fontWeight:700,color:"#f8e0e8",marginBottom:16}}>Prediction Signals</div>

            {/* Live header */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
              background:P.bgCard,border:`1px solid ${P.border}`,borderRadius:10,
              padding:"10px 14px",marginBottom:16}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:P.hot,
                  boxShadow:`0 0 8px ${P.hot}`,animation:"blink 1.2s infinite"}}/>
                <span style={{fontWeight:700,fontSize:12,color:P.soft}}>AVIATOR – LIVE SIGNAL</span>
              </div>
              <span style={{fontFamily:"'Courier New',monospace",fontSize:13,color:P.soft,fontWeight:700}}>{timeStr}</span>
            </div>

            {/* Gauge */}
            <div style={{display:"flex",justifyContent:"center",marginBottom:6}}>
              <div style={{position:"relative",width:260,height:260}}>
                <CircularGauge value={signal?.prediction||3.2} confidence={signal?.confidence||0.72}/>
                <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",textAlign:"center",width:170}}>
                  <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:9,letterSpacing:3,color:"#884466",marginBottom:4}}>SIGNAL</div>
                  <div style={{fontFamily:"'Orbitron',sans-serif",
                    fontSize:signal?.prediction>=10?34:42,fontWeight:700,
                    color:P.hot,textShadow:`0 0 30px ${P.glow}`,lineHeight:1,
                    animation:"pinkPulse 2s infinite"}}>
                    {signal?signal.prediction.toFixed(2):"3.20"}x
                  </div>
                  {/* Risk tier label inside gauge */}
                  <div style={{marginTop:6,display:"inline-block",padding:"2px 10px",
                    borderRadius:20,border:`1px solid ${riskTier.color}55`,
                    background:`${riskTier.color}15`,
                    fontFamily:"'Orbitron',sans-serif",fontSize:9,fontWeight:700,
                    color:riskTier.color,letterSpacing:2}}>{riskTier.label}</div>
                  <div style={{fontFamily:"'Courier New',monospace",fontSize:10,color:`${P.soft}88`,marginTop:6}}>{sigTimeStr}</div>
                </div>
              </div>
            </div>

            {/* Lower / Upper / Conf row */}
            <div style={{display:"flex",justifyContent:"center",gap:16,marginBottom:14,fontFamily:"'Courier New',monospace"}}>
              {[{l:"LOWER",v:`${signal?.lower.toFixed(2)||"2.80"}x`,c:"#ff69b4"},
                {l:"UPPER",v:`${signal?.upper.toFixed(2)||"3.60"}x`,c:P.hot},
                {l:"CONF", v:`${conf}%`,c:P.deep}].map(({l,v,c})=>(
                <div key={l} style={{textAlign:"center"}}>
                  <div style={{fontSize:9,color:"#553344",letterSpacing:2,marginBottom:2}}>{l}</div>
                  <div style={{fontSize:17,fontWeight:700,color:c}}>{v}</div>
                </div>
              ))}
            </div>

            {/* Terminal */}
            <div style={{marginBottom:14}}><TerminalLog lines={termLines}/></div>

            {/* ── PINK PROBABILITY CARD ── */}
            <PinkProbabilityCard history={history} minute={time.getMinutes()} second={time.getSeconds()}/>

            {/* Voice / manual input */}
            <VoiceCrashInput onAdd={handleAddCrash}/>

            {/* Next Signal */}
            <button onClick={generateSignal} style={{width:"100%",padding:"17px",
              background:`linear-gradient(135deg,${P.deep},${P.hot})`,border:"none",borderRadius:14,
              color:"white",fontSize:15,fontWeight:700,fontFamily:"'Rajdhani',sans-serif",letterSpacing:2,
              cursor:"pointer",boxShadow:`0 4px 24px ${P.glow}`,
              display:"flex",alignItems:"center",justifyContent:"center",gap:8}}
              onMouseEnter={e=>{e.target.style.transform="translateY(-2px)";}}
              onMouseLeave={e=>{e.target.style.transform="";}}
            >✈ Next Signal</button>
          </>
        )}

        {/* ── ANALYZER TAB ── */}
        {page==="analyzer"&&(
          <div>
            <div style={{fontSize:11,color:P.hot,letterSpacing:2,fontWeight:600,marginBottom:4}}>✈ AVIATOR SIGNAL BOT</div>
            <div style={{fontSize:28,fontWeight:700,color:"#f8e0e8",marginBottom:20}}>Analyzer</div>
            <PinkProbabilityCard history={history} minute={time.getMinutes()} second={time.getSeconds()}/>
            <div style={{background:P.bgCard,border:`1px solid ${P.border}`,borderRadius:12,padding:16,marginBottom:12}}>
              <div style={{fontSize:10,letterSpacing:3,color:"#664455",marginBottom:10,fontWeight:700}}>ML ENSEMBLE</div>
              {signal&&[
                {n:"Neural Network",  w:"35%",v:neuralPredict(history.slice(0,12))},
                {n:"Sequence Pattern",w:"30%",v:seqPredict(history.slice(0,12))},
                {n:"Markov Chain",     w:"20%",v:markovPredict(history.slice(0,12))},
                {n:"LSTM",             w:"10%",v:lstmPredict(history.slice(0,12))},
                {n:"Statistical",      w:"5%", v:statPredict(history.slice(0,12))},
              ].map(({n,w,v})=>(
                <div key={n} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${P.border}33`}}>
                  <div style={{minWidth:130,fontSize:11,color:"#997788",fontFamily:"'Courier New',monospace"}}>{n}</div>
                  <div style={{flex:1,height:3,background:"rgba(255,20,147,0.08)",borderRadius:2,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${Math.min(100,(v.prediction/15)*100)}%`,
                      background:`linear-gradient(90deg,${P.deep},${P.hot})`,borderRadius:2}}/>
                  </div>
                  <div style={{minWidth:45,textAlign:"right",fontFamily:"'Courier New',monospace",fontSize:12,fontWeight:700,color:P.soft}}>{v.prediction.toFixed(2)}x</div>
                  <div style={{minWidth:30,textAlign:"right",fontSize:9,color:"#664455"}}>{w}</div>
                </div>
              ))}
            </div>
            <div style={{background:P.bgCard,border:`1px solid ${P.border}`,borderRadius:12,padding:16,marginBottom:12}}>
              <div style={{fontSize:10,letterSpacing:3,color:"#664455",marginBottom:10,fontWeight:700}}>RECENT HISTORY ({history.length})</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {history.slice(0,30).map((v,i)=>(
                  <span key={i} style={{fontFamily:"'Courier New',monospace",fontSize:10,padding:"3px 8px",borderRadius:20,fontWeight:700,
                    background:v>=5?"rgba(255,20,147,0.25)":v>=3?"rgba(255,105,180,0.15)":v>=2?"rgba(194,24,91,0.15)":"rgba(100,0,50,0.2)",
                    color:v>=5?P.hot:v>=3?P.soft:v>=2?P.pale:"#aa6677"}}>{v.toFixed(2)}x</span>
                ))}
              </div>
            </div>
            <VoiceCrashInput onAdd={handleAddCrash}/>
          </div>
        )}

        {/* ── DASHBOARD TAB ── */}
        {page==="dashboard"&&(
          <div>
            <div style={{fontSize:28,fontWeight:700,color:"#f8e0e8",marginBottom:20}}>Dashboard</div>
            {[
              {label:"Total Signals",  value:history.length+47,icon:"📡",color:P.hot},
              {label:"Pink Detected",  value:history.filter(v=>v>=3).length,icon:"🌸",color:P.soft},
              {label:"Confidence",     value:`${conf}%`,icon:"🎯",color:P.pale},
              {label:"Pink Probability",value:`${calcPinkProbability(history,time.getMinutes(),time.getSeconds()).prob}%`,icon:"📈",color:"#ffb400"},
              {label:"Time Window",    value:signal?.window?.name||"SCANNING",icon:"⏱",color:P.deep},
            ].map(({label,value,icon,color})=>(
              <div key={label} style={{background:P.bgCard,border:`1px solid ${P.border}`,borderRadius:12,
                padding:"14px 18px",marginBottom:10,display:"flex",alignItems:"center",gap:14}}>
                <span style={{fontSize:24}}>{icon}</span>
                <div>
                  <div style={{fontSize:10,color:"#664455",letterSpacing:1,marginBottom:2}}>{label}</div>
                  <div style={{fontSize:22,fontWeight:700,color,fontFamily:"'Orbitron',sans-serif"}}>{value}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── PROFILE TAB ── */}
        {page==="profile"&&(
          <div>
            <div style={{fontSize:28,fontWeight:700,color:"#f8e0e8",marginBottom:20}}>Profile</div>
            <div style={{background:`linear-gradient(135deg,rgba(194,24,91,0.18),rgba(255,20,147,0.08))`,
              border:`1px solid ${P.border}`,borderRadius:16,padding:20,display:"flex",alignItems:"center",gap:14,marginBottom:20}}>
              <div style={{width:56,height:56,background:`linear-gradient(135deg,${P.deep},${P.hot})`,
                borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:"white",fontWeight:700}}>
                {user?.name?.[0]?.toUpperCase()||"U"}
              </div>
              <div>
                <div style={{fontSize:18,fontWeight:700,color:"#f8e0e8"}}>{user?.name||"User"}</div>
                <div style={{fontSize:12,color:P.soft}}>{user?.phone||"—"}</div>
                <div style={{fontSize:11,color:"#664455",marginTop:2}}>Key: {user?.key||"—"} · {user?.active?"Active":"Inactive"}</div>
              </div>
            </div>
            {[{label:"Access Level",value:"Premium"},{label:"Engine",value:"v8.0 Ensemble"},{label:"ML Models",value:"5 / 5 Active"},{label:"History",value:`${history.length} rounds`}].map(({label,value})=>(
              <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                padding:"12px 0",borderBottom:`1px solid ${P.border}33`}}>
                <span style={{fontSize:13,color:"#885566"}}>{label}</span>
                <span style={{fontSize:13,fontWeight:700,color:P.hot}}>{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user,      setUser]      = useState(null);
  const [showAdmin, setShowAdmin] = useState(false);
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:#0d050a;}
        input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;}
        ::-webkit-scrollbar{width:4px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:rgba(255,20,147,0.3);border-radius:2px;}
        @keyframes blink     {0%,100%{opacity:1}       50%{opacity:0}}
        @keyframes pinkPulse {0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.9;transform:scale(1.03)}}
        @keyframes pinkGlow  {0%,100%{box-shadow:0 0 12px rgba(255,20,147,0.3)} 50%{box-shadow:0 0 28px rgba(255,20,147,0.7)}}
        @keyframes micPulse  {0%,100%{box-shadow:0 0 8px rgba(255,20,147,0.4)} 50%{box-shadow:0 0 22px rgba(255,20,147,0.9)}}
        select option{background:#1a0510;}
      `}</style>
      {showAdmin&&<AdminPanel onClose={()=>setShowAdmin(false)}/>}
      {user
        ? <SignalScreen user={user} onAdmin={()=>setShowAdmin(true)}/>
        : <AuthScreen   onLogin={setUser}/>
      }
    </>
  );
}
