import { useState, useEffect, useRef, useCallback } from "react";

// ── Palette & Fonts ──────────────────────────────────────────────────────────
// Dark industrial terminal aesthetic: charcoal backgrounds, toxic-green
// primary signal, amber warnings, red critical, slate grid lines.

// ── Signal generators (simulation layer) ────────────────────────────────────
const SIGNAL_TYPES = ["HTTP_REQUEST","FILE_ACCESS","LOG_INFO","LOG_WARN","LOG_ERROR","NETWORK_ERR","CRASH","RETRY"];
const ENDPOINTS = ["/api/auth/login","/api/users","/api/data/fetch","/api/reports","/api/health","/static/bundle.js","/api/ws/connect"];
const FILES = ["/var/log/app.log","config/settings.json","cache/session.bin","uploads/tmp_3fa.dat","db/index.db"];
const MESSAGES = ["Connection timeout after 30s","JWT expired, refreshing token","Cache miss – fetching from DB","Rate limit exceeded (429)","Disk I/O slow: 340ms","Heap snapshot triggered","WebSocket reconnect attempt","Auth service unreachable"];

function randFrom(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }

let _id=0;
function makeSignal(forceAnomaly=false){
  const type = forceAnomaly
    ? randFrom(["HTTP_REQUEST","RETRY","CRASH","NETWORK_ERR"])
    : randFrom(SIGNAL_TYPES);
  const ts = Date.now();
  const latency = forceAnomaly ? randInt(800,4000) : randInt(10,350);
  const endpoint = randFrom(ENDPOINTS);
  const file = randFrom(FILES);
  return {
    id: ++_id,
    ts,
    type,
    endpoint: type.startsWith("HTTP")||type==="RETRY"||type==="NETWORK_ERR" ? endpoint : null,
    file: type==="FILE_ACCESS" ? file : null,
    latency,
    status: type==="HTTP_REQUEST"?(forceAnomaly?randFrom([500,503,429]):randFrom([200,200,200,201,304,404])):null,
    message: type.startsWith("LOG")||type==="CRASH"||type==="NETWORK_ERR"||type==="RETRY" ? randFrom(MESSAGES) : null,
    retryCount: type==="RETRY" ? randInt(1,15) : 0,
    anomaly: false,
    anomalyScore: 0,
  };
}

// ── Anomaly Scoring ──────────────────────────────────────────────────────────
function scoreSignal(sig, history){
  let score = 0;
  // High latency
  if(sig.latency > 500) score += 0.25 + Math.min((sig.latency-500)/3000, 0.25);
  // Error status
  if(sig.status && sig.status >= 500) score += 0.35;
  if(sig.status === 429) score += 0.4;
  // Crash
  if(sig.type === "CRASH") score += 0.7;
  // Retry storm: >3 retries in last 20 signals
  const recentRetries = history.slice(-20).filter(s=>s.type==="RETRY").length;
  if(sig.type==="RETRY"){ score += 0.15 * Math.min(sig.retryCount/5,1); }
  if(recentRetries > 4) score += 0.3;
  // Endpoint spam: same endpoint >5 times in last 15 signals
  if(sig.endpoint){
    const epCount = history.slice(-15).filter(s=>s.endpoint===sig.endpoint).length;
    if(epCount > 5) score += 0.35;
  }
  // Network errors burst
  const netErr = history.slice(-10).filter(s=>s.type==="NETWORK_ERR").length;
  if(netErr > 3) score += 0.25;
  return Math.min(score, 1);
}

// ── Root-cause hypotheses ────────────────────────────────────────────────────
async function fetchHypotheses(anomalies){
  if(!anomalies.length) return [];
  const summary = anomalies.slice(-8).map(s=>
    `[${s.type}] ${s.endpoint||s.file||s.message||""} latency=${s.latency}ms status=${s.status||"—"} retries=${s.retryCount} score=${s.anomalyScore.toFixed(2)}`
  ).join("\n");

  const prompt = `Tu es un expert en observabilité et debugging d'applications. Voici des signaux anomaux détectés en runtime :

${summary}

Génère 3 hypothèses de root-cause concises et actionnables (JSON array, champs: id, title, severity [critical|high|medium], description, action). Réponds UNIQUEMENT en JSON valide, sans markdown.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    const text = data.content?.find(b=>b.type==="text")?.text||"[]";
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  } catch(e){
    return [
      {id:1,title:"Retry storm détectée",severity:"critical",description:"Boucle de retry infinie probable sur l'endpoint auth. Le service semble indisponible.",action:"Vérifier la disponibilité du service d'authentification et ajouter un circuit-breaker."},
      {id:2,title:"Timeout réseau répétés",severity:"high",description:"Latences >1s sur plusieurs endpoints consécutifs indiquent une saturation réseau ou DNS lent.",action:"Analyser les traces réseau et vérifier la résolution DNS côté serveur."},
      {id:3,title:"Rate limiting (429)",severity:"medium",description:"L'API retourne 429 — le client envoie trop de requêtes sans back-off exponentiel.",action:"Implémenter un back-off exponentiel avec jitter dans le client HTTP."}
    ];
  }
}

// ── Severity color ───────────────────────────────────────────────────────────
function sevColor(s){ return s==="critical"?"#ff3b3b":s==="high"?"#ff9500":s==="medium"?"#ffcc00":"#4ade80"; }
function scoreColor(v){ if(v>0.7) return "#ff3b3b"; if(v>0.4) return "#ff9500"; if(v>0.2) return "#ffcc00"; return "#4ade80"; }
function typeColor(t){
  if(t==="CRASH") return "#ff3b3b";
  if(t==="NETWORK_ERR"||t==="LOG_ERROR") return "#ff5555";
  if(t==="RETRY"||t==="LOG_WARN") return "#ff9500";
  if(t==="HTTP_REQUEST") return "#4ade80";
  if(t==="FILE_ACCESS") return "#60a5fa";
  return "#a3a3a3";
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function DynamicBehaviorProfiler(){
  const [signals, setSignals] = useState([]);
  const [anomalies, setAnomalies] = useState([]);
  const [hypotheses, setHypotheses] = useState([]);
  const [running, setRunning] = useState(false);
  const [loadingHypo, setLoadingHypo] = useState(false);
  const [stats, setStats] = useState({total:0,anomalyCount:0,avgLatency:0,errorRate:0,retryRate:0});
  const [filter, setFilter] = useState("ALL");
  const [anomalyMode, setAnomalyMode] = useState(false);
  const intervalRef = useRef(null);
  const historyRef = useRef([]);
  const feedRef = useRef(null);

  const addSignal = useCallback(()=>{
    const forceAnomaly = anomalyMode && Math.random()<0.45;
    const raw = makeSignal(forceAnomaly);
    const score = scoreSignal(raw, historyRef.current);
    const sig = {...raw, anomalyScore:score, anomaly: score>0.35};
    historyRef.current = [...historyRef.current.slice(-200), sig];

    setSignals(prev=>{
      const next = [sig, ...prev].slice(0,120);
      // recompute stats
      const total = next.length;
      const aCount = next.filter(s=>s.anomaly).length;
      const avgLat = Math.round(next.reduce((a,s)=>a+s.latency,0)/total);
      const errRate = Math.round(next.filter(s=>s.status&&s.status>=400).length/total*100);
      const retRate = Math.round(next.filter(s=>s.type==="RETRY").length/total*100);
      setStats({total, anomalyCount:aCount, avgLatency:avgLat, errorRate:errRate, retryRate:retRate});
      setAnomalies(next.filter(s=>s.anomaly).slice(0,40));
      return next;
    });
  },[anomalyMode]);

  useEffect(()=>{
    if(running){
      const speed = anomalyMode ? 400 : 700;
      intervalRef.current = setInterval(addSignal, speed);
    } else {
      clearInterval(intervalRef.current);
    }
    return ()=>clearInterval(intervalRef.current);
  },[running, addSignal, anomalyMode]);

  const handleAnalyze = async()=>{
    setLoadingHypo(true);
    const h = await fetchHypotheses(anomalies);
    setHypotheses(h);
    setLoadingHypo(false);
  };

  const reset=()=>{
    setRunning(false);
    setSignals([]);
    setAnomalies([]);
    setHypotheses([]);
    historyRef.current=[];
    setStats({total:0,anomalyCount:0,avgLatency:0,errorRate:0,retryRate:0});
    _id=0;
  };

  const filtered = filter==="ALL" ? signals : filter==="ANOMALY" ? signals.filter(s=>s.anomaly) : signals.filter(s=>s.type===filter);

  // Sparkline data for latency (last 30)
  const sparkData = signals.slice(0,30).reverse().map(s=>s.latency);
  const sparkMax = Math.max(...sparkData,1);

  const fmtTs=(ts)=>{
    const d=new Date(ts);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
  };

  return (
    <div style={{
      fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace",
      background:"#0a0c0f",
      minHeight:"100vh",
      color:"#c8d0d8",
      padding:"0",
      overflow:"hidden",
    }}>
      {/* ── Scanline overlay ── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700&family=Syne:wght@700;800&display=swap');
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:#111}
        ::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
        .feed-row{transition:background .15s;border-left:2px solid transparent}
        .feed-row:hover{background:rgba(255,255,255,.03)!important}
        .feed-row.anom{border-left-color:#ff3b3b;animation:pulse-row .6s ease}
        @keyframes pulse-row{0%{background:rgba(255,59,59,.18)}100%{background:transparent}}
        .btn{cursor:pointer;border:none;font-family:inherit;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:7px 18px;border-radius:3px;transition:all .15s;font-weight:600}
        .btn-green{background:#1a3a1a;color:#4ade80;border:1px solid #2d6a2d}
        .btn-green:hover{background:#2d6a2d;color:#fff}
        .btn-red{background:#3a1a1a;color:#ff5555;border:1px solid #6a2d2d}
        .btn-red:hover{background:#6a2d2d;color:#fff}
        .btn-amber{background:#3a2d1a;color:#ff9500;border:1px solid #6a4a1a}
        .btn-amber:hover{background:#6a4a1a;color:#fff}
        .btn-slate{background:#1a1d22;color:#8090a0;border:1px solid #2a3040}
        .btn-slate:hover{background:#2a3040;color:#c8d0d8}
        .tag{display:inline-block;padding:1px 7px;border-radius:2px;font-size:10px;font-weight:700;letter-spacing:.06em}
        .hypo-card{background:#0e1117;border:1px solid #1e2530;border-radius:4px;padding:14px 16px;margin-bottom:10px;transition:border-color .2s}
        .hypo-card:hover{border-color:#334}
        .filter-btn{cursor:pointer;padding:4px 10px;border-radius:2px;font-family:inherit;font-size:10px;font-weight:700;letter-spacing:.06em;border:1px solid #1e2530;background:#0e1117;color:#607080;transition:all .15s}
        .filter-btn.active{color:#4ade80;border-color:#2d6a2d;background:#1a2a1a}
        .filter-btn:hover{border-color:#334;color:#c8d0d8}
        .score-bar{height:3px;border-radius:2px;transition:width .3s}
        .stat-box{background:#0e1117;border:1px solid #1e2530;border-radius:4px;padding:12px 16px;flex:1}
        .grid-bg{background-image:linear-gradient(rgba(255,255,255,.015) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.015) 1px,transparent 1px);background-size:32px 32px}
      `}</style>

      {/* ── Header ── */}
      <div style={{background:"#0a0c0f",borderBottom:"1px solid #1e2530",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:8,height:8,borderRadius:"50%",background: running?"#4ade80":"#ff3b3b",boxShadow: running?"0 0 8px #4ade80":"none",animation: running?"blink 1s infinite":"none"}}/>
          <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
          <span style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:17,color:"#e8f0f8",letterSpacing:".02em"}}>DYNAMIC BEHAVIOR PROFILER</span>
          <span style={{fontSize:10,color:"#4060a0",marginLeft:4}}>v2.0 · runtime anomaly detection</span>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button className="btn btn-slate" onClick={()=>setAnomalyMode(m=>!m)}
            style={anomalyMode?{background:"#2a1a3a",color:"#c084fc",borderColor:"#5a3080"}:{}}
          >
            {anomalyMode?"⚡ STRESS ON":"⚡ STRESS OFF"}
          </button>
          <button className="btn" style={{background: running?"#3a1a1a":"#1a3a1a",color:running?"#ff5555":"#4ade80",border:`1px solid ${running?"#6a2d2d":"#2d6a2d"}`}}
            onClick={()=>setRunning(r=>!r)}>
            {running?"⏹ STOP":"▶ START"}
          </button>
          <button className="btn btn-amber" onClick={handleAnalyze} disabled={!anomalies.length||loadingHypo}>
            {loadingHypo?"⟳ ANALYZING...":"🔍 ANALYZE"}
          </button>
          <button className="btn btn-slate" onClick={reset}>↺ RESET</button>
        </div>
      </div>

      <div className="grid-bg" style={{padding:"16px 24px",display:"grid",gridTemplateColumns:"1fr 340px",gap:16,height:"calc(100vh - 57px)",overflow:"hidden"}}>

        {/* ── LEFT PANEL ── */}
        <div style={{display:"flex",flexDirection:"column",gap:12,overflow:"hidden"}}>

          {/* Stats row */}
          <div style={{display:"flex",gap:10}}>
            {[
              {label:"TOTAL SIGNALS",value:stats.total,color:"#c8d0d8"},
              {label:"ANOMALIES",value:stats.anomalyCount,color:"#ff5555"},
              {label:"AVG LATENCY",value:stats.avgLatency+"ms",color: stats.avgLatency>500?"#ff5555":stats.avgLatency>200?"#ff9500":"#4ade80"},
              {label:"ERROR RATE",value:stats.errorRate+"%",color:stats.errorRate>20?"#ff5555":stats.errorRate>10?"#ff9500":"#4ade80"},
              {label:"RETRY RATE",value:stats.retryRate+"%",color:stats.retryRate>15?"#ff5555":stats.retryRate>8?"#ff9500":"#4ade80"},
            ].map(s=>(
              <div key={s.label} className="stat-box">
                <div style={{fontSize:9,color:"#405060",letterSpacing:".1em",marginBottom:4}}>{s.label}</div>
                <div style={{fontSize:20,fontWeight:700,color:s.color,fontFamily:"'Syne',sans-serif"}}>{s.value||"—"}</div>
              </div>
            ))}
          </div>

          {/* Latency Sparkline */}
          <div style={{background:"#0e1117",border:"1px solid #1e2530",borderRadius:4,padding:"10px 16px"}}>
            <div style={{fontSize:9,color:"#405060",letterSpacing:".1em",marginBottom:8}}>LATENCY TIMELINE (last 30 signals)</div>
            <svg width="100%" height="40" viewBox={`0 0 ${sparkData.length*18||1} 40`} preserveAspectRatio="none">
              {sparkData.map((v,i)=>{
                const h=Math.max(2,(v/sparkMax)*38);
                const color = v>500?"#ff3b3b":v>200?"#ff9500":"#4ade80";
                return <rect key={i} x={i*18+1} y={40-h} width={14} height={h} fill={color} opacity={.85} rx={1}/>;
              })}
            </svg>
          </div>

          {/* Feed filters */}
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {["ALL","ANOMALY","HTTP_REQUEST","FILE_ACCESS","LOG_WARN","LOG_ERROR","RETRY","CRASH","NETWORK_ERR"].map(f=>(
              <button key={f} className={`filter-btn ${filter===f?"active":""}`} onClick={()=>setFilter(f)}>{f}</button>
            ))}
          </div>

          {/* Signal Feed */}
          <div ref={feedRef} style={{flex:1,overflow:"auto",background:"#0a0c0f",border:"1px solid #1e2530",borderRadius:4}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead>
                <tr style={{background:"#0e1117",position:"sticky",top:0}}>
                  {["TIME","TYPE","ENDPOINT / FILE / MESSAGE","LAT","STATUS","SCORE"].map(h=>(
                    <th key={h} style={{padding:"7px 10px",textAlign:"left",color:"#405060",fontWeight:600,fontSize:9,letterSpacing:".1em",borderBottom:"1px solid #1e2530"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(s=>(
                  <tr key={s.id} className={`feed-row ${s.anomaly?"anom":""}`}
                    style={{borderBottom:"1px solid rgba(255,255,255,.03)"}}>
                    <td style={{padding:"5px 10px",color:"#405070",whiteSpace:"nowrap",fontSize:10}}>{fmtTs(s.ts)}</td>
                    <td style={{padding:"5px 10px"}}>
                      <span className="tag" style={{background:typeColor(s.type)+"22",color:typeColor(s.type)}}>{s.type}</span>
                    </td>
                    <td style={{padding:"5px 10px",color:"#8090a8",maxWidth:240,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {s.endpoint||s.file||s.message||"—"}
                      {s.retryCount>0&&<span style={{marginLeft:6,color:"#ff9500",fontSize:10}}>×{s.retryCount}</span>}
                    </td>
                    <td style={{padding:"5px 10px",color:s.latency>500?"#ff3b3b":s.latency>200?"#ff9500":"#4ade80",whiteSpace:"nowrap"}}>{s.latency}ms</td>
                    <td style={{padding:"5px 10px",color:s.status>=500?"#ff3b3b":s.status===429?"#ff9500":s.status>=400?"#ffcc00":s.status?"#4ade80":"#405060"}}>
                      {s.status||"—"}
                    </td>
                    <td style={{padding:"5px 10px",minWidth:80}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <div style={{flex:1,background:"#1a2030",borderRadius:2,height:3}}>
                          <div className="score-bar" style={{width:`${s.anomalyScore*100}%`,background:scoreColor(s.anomalyScore)}}/>
                        </div>
                        <span style={{color:scoreColor(s.anomalyScore),fontSize:10,minWidth:32}}>{(s.anomalyScore*100).toFixed(0)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length===0&&(
                  <tr><td colSpan={6} style={{padding:32,textAlign:"center",color:"#304050",fontSize:12}}>
                    {running?"Waiting for signals…":"Press START to begin profiling"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── RIGHT PANEL ── */}
        <div style={{display:"flex",flexDirection:"column",gap:12,overflow:"hidden"}}>

          {/* Anomaly summary */}
          <div style={{background:"#0e1117",border:"1px solid #1e2530",borderRadius:4,padding:"14px 16px"}}>
            <div style={{fontSize:9,color:"#405060",letterSpacing:".1em",marginBottom:12}}>ANOMALY DISTRIBUTION</div>
            {[
              {label:"CRASH",count: anomalies.filter(s=>s.type==="CRASH").length, color:"#ff3b3b"},
              {label:"RETRY STORM",count: anomalies.filter(s=>s.type==="RETRY"&&s.retryCount>5).length, color:"#ff6b35"},
              {label:"HTTP 5xx",count: anomalies.filter(s=>s.status>=500).length, color:"#ff9500"},
              {label:"RATE LIMIT",count: anomalies.filter(s=>s.status===429).length, color:"#ffcc00"},
              {label:"HIGH LATENCY",count: anomalies.filter(s=>s.latency>1000).length, color:"#c084fc"},
              {label:"NET ERRORS",count: anomalies.filter(s=>s.type==="NETWORK_ERR").length, color:"#60a5fa"},
            ].map(item=>{
              const pct = anomalies.length ? (item.count/anomalies.length)*100 : 0;
              return (
                <div key={item.label} style={{marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:3}}>
                    <span style={{color:"#607080"}}>{item.label}</span>
                    <span style={{color:item.color,fontWeight:700}}>{item.count}</span>
                  </div>
                  <div style={{background:"#1a2030",borderRadius:2,height:3}}>
                    <div style={{width:`${pct}%`,height:3,background:item.color,borderRadius:2,transition:"width .4s"}}/>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Root cause hypotheses */}
          <div style={{flex:1,overflow:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:9,color:"#405060",letterSpacing:".1em"}}>ROOT CAUSE HYPOTHESES</div>
              {anomalies.length>0&&<span style={{fontSize:10,color:"#ff5555"}}>{anomalies.length} anomalies</span>}
            </div>

            {loadingHypo&&(
              <div style={{textAlign:"center",padding:40,color:"#4ade80"}}>
                <div style={{fontSize:12,animation:"blink 1s infinite"}}>⟳ ANALYZING PATTERNS...</div>
                <div style={{fontSize:10,color:"#405060",marginTop:8}}>Running anomaly correlation engine</div>
              </div>
            )}

            {!loadingHypo && hypotheses.length===0 && (
              <div style={{textAlign:"center",padding:32,color:"#304050",fontSize:11,border:"1px dashed #1a2530",borderRadius:4}}>
                <div style={{fontSize:24,marginBottom:8}}>🔬</div>
                Collect anomalies then click<br/>
                <span style={{color:"#ff9500"}}>ANALYZE</span> to generate hypotheses
              </div>
            )}

            {hypotheses.map(h=>(
              <div key={h.id} className="hypo-card">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                  <span style={{color:"#e8f0f8",fontWeight:700,fontSize:12}}>{h.title}</span>
                  <span className="tag" style={{background:sevColor(h.severity)+"22",color:sevColor(h.severity),marginLeft:8,flexShrink:0}}>{h.severity}</span>
                </div>
                <p style={{fontSize:11,color:"#607080",lineHeight:1.6,margin:"0 0 8px"}}>{h.description}</p>
                <div style={{background:"#0a1218",borderRadius:3,padding:"7px 10px",borderLeft:"2px solid #ff9500"}}>
                  <span style={{fontSize:9,color:"#ff9500",letterSpacing:".08em"}}>ACTION → </span>
                  <span style={{fontSize:10,color:"#a0b0c0"}}>{h.action}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Recent anomalies mini-feed */}
          {anomalies.length>0&&(
            <div style={{background:"#0e1117",border:"1px solid #1e2530",borderRadius:4,padding:"10px 14px",maxHeight:160,overflow:"auto"}}>
              <div style={{fontSize:9,color:"#405060",letterSpacing:".1em",marginBottom:8}}>RECENT ANOMALIES</div>
              {anomalies.slice(0,12).map(s=>(
                <div key={s.id} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid rgba(255,255,255,.03)",fontSize:10}}>
                  <span style={{color:typeColor(s.type)}}>{s.type}</span>
                  <span style={{color:"#607080",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:120,margin:"0 8px"}}>{s.endpoint||s.file||s.message||"—"}</span>
                  <span style={{color:scoreColor(s.anomalyScore),flexShrink:0}}>{(s.anomalyScore*100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}