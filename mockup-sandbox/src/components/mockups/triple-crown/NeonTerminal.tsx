import { useState } from "react";

const PLAYERS = [
  { rank: 1, name: "Aaron Judge", team: "NYY", hr: 37, ba: 0.311, rbi: 88, prob: 0.412, trend: "up" },
  { rank: 2, name: "Shohei Ohtani", team: "LAD", hr: 34, ba: 0.304, rbi: 95, prob: 0.387, trend: "up" },
  { rank: 3, name: "Yordan Alvarez", team: "HOU", hr: 31, ba: 0.296, rbi: 97, prob: 0.361, trend: "up" },
  { rank: 4, name: "Pete Alonso", team: "NYM", hr: 38, ba: 0.249, rbi: 105, prob: 0.341, trend: "flat" },
  { rank: 5, name: "Gunnar Henderson", team: "BAL", hr: 37, ba: 0.283, rbi: 99, prob: 0.328, trend: "up" },
  { rank: 6, name: "Matt Olson", team: "ATL", hr: 40, ba: 0.241, rbi: 103, prob: 0.318, trend: "flat" },
  { rank: 7, name: "Bryce Harper", team: "PHI", hr: 30, ba: 0.299, rbi: 89, prob: 0.304, trend: "down" },
  { rank: 8, name: "Jose Ramirez", team: "CLE", hr: 33, ba: 0.293, rbi: 102, prob: 0.291, trend: "flat" },
];

const GAMES = [
  { home: "NYY", away: "BOS", time: "7:05 PM", status: "LIVE", homeScore: 4, awayScore: 2, inning: "T6" },
  { home: "BAL", away: "TOR", time: "7:05 PM", status: "LIVE", homeScore: 3, awayScore: 1, inning: "B4" },
  { home: "LAD", away: "ATL", time: "10:10 PM", status: "PRE", homeScore: null, awayScore: null, inning: null },
  { home: "HOU", away: "TEX", time: "8:10 PM", status: "PRE", homeScore: null, awayScore: null, inning: null },
  { home: "CHC", away: "NYM", time: "7:40 PM", status: "PRE", homeScore: null, awayScore: null, inning: null },
];

const NAV = ["Dashboard", "Games", "Players", "Top Picks", "Predictions", "Weather", "Odds"];

function TrendIcon({ trend }: { trend: string }) {
  if (trend === "up") return <span style={{ color: "#00ff88" }}>▲</span>;
  if (trend === "down") return <span style={{ color: "#ff4466" }}>▼</span>;
  return <span style={{ color: "#666" }}>—</span>;
}

function ProbBar({ value }: { value: number }) {
  const color = value >= 0.35 ? "#00ff88" : value >= 0.25 ? "#00d4ff" : "#ff8800";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 3, background: "#111", borderRadius: 2 }}>
        <div style={{ width: `${value * 100}%`, height: "100%", background: color, borderRadius: 2, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <span style={{ fontFamily: "monospace", fontSize: 12, color, minWidth: 38, textAlign: "right" }}>
        {(value * 100).toFixed(1)}%
      </span>
    </div>
  );
}

export function NeonTerminal() {
  const [activeNav, setActiveNav] = useState("Dashboard");

  return (
    <div style={{
      width: "100%", minHeight: "100vh",
      background: "#000",
      color: "#ccc",
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
      display: "flex",
      fontSize: 13,
    }}>
      {/* Sidebar */}
      <div style={{
        width: 200,
        background: "#050505",
        borderRight: "1px solid #00ff8822",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ padding: "20px 16px 16px", borderBottom: "1px solid #00ff8822" }}>
          <div style={{ fontSize: 11, color: "#00ff88", letterSpacing: 4, marginBottom: 2 }}>TRIPLE</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#fff", letterSpacing: 2, lineHeight: 1 }}>CROWN</div>
          <div style={{ fontSize: 10, color: "#00ff8866", letterSpacing: 3, marginTop: 2 }}>AI // v2.1</div>
        </div>

        {/* Status */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid #00ff8822" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#00ff88", boxShadow: "0 0 8px #00ff88" }} />
            <span style={{ fontSize: 10, color: "#00ff8899", letterSpacing: 2 }}>SYS LIVE</span>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "8px 0" }}>
          {NAV.map((item) => {
            const isActive = item === activeNav;
            return (
              <button
                key={item}
                onClick={() => setActiveNav(item)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", padding: "9px 16px",
                  background: isActive ? "#00ff8811" : "transparent",
                  border: "none",
                  borderLeft: isActive ? "2px solid #00ff88" : "2px solid transparent",
                  color: isActive ? "#00ff88" : "#666",
                  fontFamily: "inherit",
                  fontSize: 11,
                  letterSpacing: 1,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ fontSize: 10 }}>{">"}</span>
                {item.toUpperCase()}
                {item === "Games" && (
                  <span style={{
                    marginLeft: "auto", fontSize: 9, background: "#ff4444",
                    color: "#fff", padding: "1px 4px", borderRadius: 2,
                  }}>2</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Model info */}
        <div style={{ padding: "12px 16px", borderTop: "1px solid #00ff8822" }}>
          <div style={{ fontSize: 9, color: "#333", letterSpacing: 1, marginBottom: 4 }}>MODEL</div>
          <div style={{ fontSize: 11, color: "#00d4ff" }}>XGBoost v2.1</div>
          <div style={{ fontSize: 9, color: "#444", marginTop: 2 }}>ACC: 73.1%</div>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        <div style={{
          borderBottom: "1px solid #00ff8822",
          padding: "12px 24px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 10, color: "#444", letterSpacing: 2 }}>SYS /</span>
            <span style={{ fontSize: 13, color: "#fff", letterSpacing: 2 }}>{activeNav.toUpperCase()}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <span style={{ fontSize: 10, color: "#444" }}>TUE JUL 01 2026</span>
            <span style={{ fontSize: 10, color: "#00ff8888", letterSpacing: 2 }}>07:14:22</span>
            <div style={{
              background: "#00ff8811", border: "1px solid #00ff8833",
              padding: "4px 10px", fontSize: 10, color: "#00ff88", letterSpacing: 2,
            }}>
              DARK MODE
            </div>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>

          {/* Stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
            {[
              { label: "GAMES TODAY", value: "7", sub: "2 LIVE NOW", color: "#00ff88" },
              { label: "MODEL ACCURACY", value: "73.1%", sub: "LAST 7 DAYS", color: "#00d4ff" },
              { label: "TOP CONTENDER", value: "A. JUDGE", sub: "41.2% PROB", color: "#ff8800" },
              { label: "PREDICTIONS", value: "15", sub: "GENERATED TODAY", color: "#aa44ff" },
            ].map((card) => (
              <div key={card.label} style={{
                background: "#050505",
                border: `1px solid ${card.color}22`,
                padding: "16px",
                position: "relative",
                overflow: "hidden",
              }}>
                <div style={{
                  position: "absolute", top: 0, left: 0, right: 0, height: 1,
                  background: `linear-gradient(90deg, transparent, ${card.color}88, transparent)`,
                }} />
                <div style={{ fontSize: 9, color: "#555", letterSpacing: 3, marginBottom: 8 }}>{card.label}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: card.color, letterSpacing: 1, marginBottom: 4, textShadow: `0 0 20px ${card.color}66` }}>
                  {card.value}
                </div>
                <div style={{ fontSize: 9, color: "#444", letterSpacing: 2 }}>{card.sub}</div>
                <div style={{
                  position: "absolute", bottom: -20, right: -20, width: 80, height: 80,
                  borderRadius: "50%", background: card.color, opacity: 0.03,
                }} />
              </div>
            ))}
          </div>

          {/* Main grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 16 }}>

            {/* Leaderboard */}
            <div style={{ background: "#050505", border: "1px solid #00ff8822" }}>
              <div style={{
                padding: "12px 16px", borderBottom: "1px solid #00ff8822",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 2, height: 14, background: "#00ff88", boxShadow: "0 0 6px #00ff88" }} />
                  <span style={{ fontSize: 10, color: "#fff", letterSpacing: 3 }}>HR PROBABILITY LEADERBOARD</span>
                </div>
                <span style={{ fontSize: 9, color: "#444", letterSpacing: 2 }}>LIVE FEED</span>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #111" }}>
                    {["RNK", "PLAYER", "TEAM", "TODAY %", "TREND", "HR", "BA", "RBI"].map((h) => (
                      <th key={h} style={{
                        padding: "8px 12px", textAlign: "left",
                        fontSize: 9, color: "#444", letterSpacing: 2, fontWeight: 400,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PLAYERS.map((p, i) => {
                    const probColor = p.prob >= 0.35 ? "#00ff88" : p.prob >= 0.25 ? "#00d4ff" : "#ff8800";
                    return (
                      <tr key={p.name} style={{
                        borderBottom: "1px solid #0a0a0a",
                        background: i % 2 === 0 ? "transparent" : "#030303",
                        cursor: "pointer",
                      }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#00ff8808")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = i % 2 === 0 ? "transparent" : "#030303")}
                      >
                        <td style={{ padding: "10px 12px", color: "#444", fontSize: 11 }}>{String(p.rank).padStart(2, "0")}</td>
                        <td style={{ padding: "10px 12px", color: "#fff", fontSize: 12 }}>{p.name}</td>
                        <td style={{ padding: "10px 12px" }}>
                          <span style={{
                            background: "#111", border: "1px solid #222",
                            padding: "2px 6px", fontSize: 9, color: "#888", letterSpacing: 1,
                          }}>{p.team}</span>
                        </td>
                        <td style={{ padding: "10px 12px" }}>
                          <span style={{
                            color: probColor, fontSize: 13, fontWeight: 700,
                            textShadow: `0 0 10px ${probColor}88`,
                          }}>
                            {(p.prob * 100).toFixed(1)}%
                          </span>
                        </td>
                        <td style={{ padding: "10px 12px", fontSize: 13 }}><TrendIcon trend={p.trend} /></td>
                        <td style={{ padding: "10px 12px", color: "#ccc", fontSize: 12 }}>{p.hr}</td>
                        <td style={{ padding: "10px 12px", color: "#888", fontSize: 11 }}>{p.ba.toFixed(3)}</td>
                        <td style={{ padding: "10px 12px", color: "#888", fontSize: 11 }}>{p.rbi}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Right panel */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

              {/* Live games */}
              <div style={{ background: "#050505", border: "1px solid #00ff8822" }}>
                <div style={{
                  padding: "10px 14px", borderBottom: "1px solid #00ff8822",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#ff4444", boxShadow: "0 0 8px #ff4444" }} />
                  <span style={{ fontSize: 9, color: "#fff", letterSpacing: 3 }}>LIVE GAMES</span>
                  <span style={{ marginLeft: "auto", fontSize: 9, color: "#444" }}>{GAMES.length} TOTAL</span>
                </div>
                <div style={{ padding: 8 }}>
                  {GAMES.map((g, i) => (
                    <div key={i} style={{
                      padding: "8px 10px",
                      border: `1px solid ${g.status === "LIVE" ? "#ff444422" : "#111"}`,
                      background: g.status === "LIVE" ? "#ff44440a" : "transparent",
                      marginBottom: i < GAMES.length - 1 ? 6 : 0,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div>
                          <span style={{ color: "#fff", fontSize: 12, fontWeight: 600 }}>{g.away}</span>
                          <span style={{ color: "#444", fontSize: 11, margin: "0 6px" }}>@</span>
                          <span style={{ color: "#fff", fontSize: 12, fontWeight: 600 }}>{g.home}</span>
                        </div>
                        {g.status === "LIVE" ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ color: "#ff4444", fontSize: 11, fontWeight: 700 }}>
                              {g.awayScore}–{g.homeScore}
                            </span>
                            <span style={{ fontSize: 9, color: "#ff444488", letterSpacing: 1 }}>{g.inning}</span>
                          </div>
                        ) : (
                          <span style={{ fontSize: 10, color: "#444" }}>{g.time}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Top picks */}
              <div style={{ background: "#050505", border: "1px solid #00ff8822", flex: 1 }}>
                <div style={{
                  padding: "10px 14px", borderBottom: "1px solid #00ff8822",
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  <div style={{ width: 2, height: 12, background: "#ff8800", boxShadow: "0 0 6px #ff8800" }} />
                  <span style={{ fontSize: 9, color: "#fff", letterSpacing: 3 }}>TOP PICKS TODAY</span>
                </div>
                <div style={{ padding: 10 }}>
                  {PLAYERS.slice(0, 5).map((p, i) => {
                    const color = i === 0 ? "#00ff88" : i < 3 ? "#00d4ff" : "#ff8800";
                    return (
                      <div key={p.name} style={{
                        marginBottom: 10, paddingBottom: 10,
                        borderBottom: i < 4 ? "1px solid #111" : "none",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 9, color: "#444", minWidth: 18 }}>#{i + 1}</span>
                            <span style={{ fontSize: 12, color: "#fff" }}>{p.name}</span>
                            <span style={{ fontSize: 9, color: "#555", letterSpacing: 1 }}>{p.team}</span>
                          </div>
                          <TrendIcon trend={p.trend} />
                        </div>
                        <ProbBar value={p.prob} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
