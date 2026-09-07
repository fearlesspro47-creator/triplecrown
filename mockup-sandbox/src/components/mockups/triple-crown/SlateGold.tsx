import { useState } from "react";

const PLAYERS = [
  { rank: 1, name: "Aaron Judge", team: "New York Yankees", abbr: "NYY", hr: 37, ba: 0.311, rbi: 88, prob: 0.412, trend: "up" },
  { rank: 2, name: "Shohei Ohtani", team: "Los Angeles Dodgers", abbr: "LAD", hr: 34, ba: 0.304, rbi: 95, prob: 0.387, trend: "up" },
  { rank: 3, name: "Yordan Alvarez", team: "Houston Astros", abbr: "HOU", hr: 31, ba: 0.296, rbi: 97, prob: 0.361, trend: "up" },
  { rank: 4, name: "Pete Alonso", team: "New York Mets", abbr: "NYM", hr: 38, ba: 0.249, rbi: 105, prob: 0.341, trend: "flat" },
  { rank: 5, name: "Gunnar Henderson", team: "Baltimore Orioles", abbr: "BAL", hr: 37, ba: 0.283, rbi: 99, prob: 0.328, trend: "up" },
  { rank: 6, name: "Matt Olson", team: "Atlanta Braves", abbr: "ATL", hr: 40, ba: 0.241, rbi: 103, prob: 0.318, trend: "flat" },
  { rank: 7, name: "Bryce Harper", team: "Philadelphia Phillies", abbr: "PHI", hr: 30, ba: 0.299, rbi: 89, prob: 0.304, trend: "down" },
  { rank: 8, name: "Jose Ramirez", team: "Cleveland Guardians", abbr: "CLE", hr: 33, ba: 0.293, rbi: 102, prob: 0.291, trend: "flat" },
];

const GAMES = [
  { home: "NYY", away: "BOS", time: "7:05 PM", status: "live", homeScore: 4, awayScore: 2, inning: "T6" },
  { home: "BAL", away: "TOR", time: "7:05 PM", status: "live", homeScore: 3, awayScore: 1, inning: "B4" },
  { home: "LAD", away: "ATL", time: "10:10 PM", status: "pre" },
  { home: "HOU", away: "TEX", time: "8:10 PM", status: "pre" },
  { home: "CHC", away: "NYM", time: "7:40 PM", status: "pre" },
];

const NAV = [
  { label: "Dashboard", icon: "◈" },
  { label: "Games", icon: "◉", badge: "2 LIVE" },
  { label: "Players", icon: "◎" },
  { label: "Top Picks", icon: "◆" },
  { label: "Predictions", icon: "◐" },
  { label: "Weather", icon: "◌" },
  { label: "Odds", icon: "◇" },
];

function TrendBadge({ trend }: { trend: string }) {
  if (trend === "up") return (
    <span style={{ color: "#22c55e", fontSize: 12, fontWeight: 700 }}>↑</span>
  );
  if (trend === "down") return (
    <span style={{ color: "#ef4444", fontSize: 12, fontWeight: 700 }}>↓</span>
  );
  return <span style={{ color: "#64748b", fontSize: 12 }}>—</span>;
}

function ProbArc({ value }: { value: number }) {
  const color = value >= 0.35 ? "#22c55e" : value >= 0.25 ? "#f59e0b" : "#ef4444";
  const pct = Math.round(value * 100);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{
        width: 48, height: 48, borderRadius: "50%",
        background: `conic-gradient(${color} ${pct * 3.6}deg, #1e293b ${pct * 3.6}deg)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        position: "relative",
      }}>
        <div style={{
          width: 34, height: 34, borderRadius: "50%",
          background: "#0f172a",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color }}>{pct}%</span>
        </div>
      </div>
    </div>
  );
}

export function SlateGold() {
  const [activeNav, setActiveNav] = useState("Dashboard");
  const [isDark, setIsDark] = useState(true);

  return (
    <div style={{
      width: "100%", minHeight: "100vh",
      background: "#0f172a",
      color: "#e2e8f0",
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      display: "flex",
      fontSize: 14,
    }}>
      {/* Sidebar */}
      <div style={{
        width: 220,
        background: "#0a1120",
        borderRight: "1px solid #1e293b",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ padding: "22px 20px 18px", borderBottom: "1px solid #1e293b" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: "linear-gradient(135deg, #f59e0b, #d97706)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, flexShrink: 0,
              boxShadow: "0 4px 12px #f59e0b44",
            }}>
              ⚾
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", letterSpacing: -0.5 }}>Triple Crown</div>
              <div style={{ fontSize: 10, color: "#f59e0b", fontWeight: 600, letterSpacing: 1 }}>AI ANALYTICS</div>
            </div>
          </div>
        </div>

        {/* Live badge */}
        <div style={{ padding: "10px 20px", borderBottom: "1px solid #1e293b" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            background: "#22c55e18", border: "1px solid #22c55e33",
            padding: "4px 10px", borderRadius: 20,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e" }} />
            <span style={{ fontSize: 10, color: "#22c55e", fontWeight: 600, letterSpacing: 1 }}>SYSTEM LIVE</span>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "10px 10px" }}>
          {NAV.map((item) => {
            const isActive = item.label === activeNav;
            return (
              <button
                key={item.label}
                onClick={() => setActiveNav(item.label)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", padding: "9px 12px",
                  background: isActive ? "#f59e0b18" : "transparent",
                  border: "none",
                  borderRadius: 8,
                  color: isActive ? "#f59e0b" : "#64748b",
                  fontFamily: "inherit",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.15s",
                  marginBottom: 2,
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#1e293b"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ fontSize: 14 }}>{item.icon}</span>
                {item.label}
                {item.badge && (
                  <span style={{
                    marginLeft: "auto", fontSize: 9, background: "#ef444422",
                    color: "#ef4444", padding: "2px 6px", borderRadius: 4,
                    fontWeight: 700, letterSpacing: 0.5,
                  }}>{item.badge}</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Model card */}
        <div style={{
          margin: 10,
          background: "linear-gradient(135deg, #1e293b, #162032)",
          borderRadius: 10, padding: 14,
          border: "1px solid #f59e0b22",
        }}>
          <div style={{ fontSize: 10, color: "#475569", fontWeight: 600, letterSpacing: 1, marginBottom: 6 }}>MODEL STATUS</div>
          <div style={{ fontSize: 13, color: "#f59e0b", fontWeight: 700 }}>XGBoost v2.1</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>Accuracy: 73.1%</div>
          <div style={{
            marginTop: 8, height: 4, background: "#1e293b", borderRadius: 2,
          }}>
            <div style={{ width: "73.1%", height: "100%", background: "linear-gradient(90deg, #f59e0b, #d97706)", borderRadius: 2 }} />
          </div>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Header */}
        <div style={{
          borderBottom: "1px solid #1e293b",
          padding: "14px 28px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "#0a1120",
        }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fff", letterSpacing: -0.5 }}>Dashboard</div>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 1 }}>Tuesday, July 1, 2026 · 7 games scheduled</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button style={{
              background: "#1e293b", border: "1px solid #334155",
              color: "#94a3b8", padding: "7px 14px", borderRadius: 8,
              fontSize: 12, fontFamily: "inherit", cursor: "pointer",
            }}>
              Refresh Data
            </button>
            <div style={{
              width: 36, height: 36, borderRadius: "50%",
              background: "linear-gradient(135deg, #f59e0b, #d97706)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 700, color: "#fff",
            }}>A</div>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>

          {/* Stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
            {[
              { label: "Games Today", value: "7", sub: "2 Live Now", accent: "#3b82f6", icon: "◎" },
              { label: "Model Accuracy", value: "73.1%", sub: "Last 7 days", accent: "#f59e0b", icon: "◆" },
              { label: "Top Contender", value: "A. Judge", sub: "41.2% HR Probability", accent: "#22c55e", icon: "◈" },
              { label: "Predictions", value: "15", sub: "Generated today", accent: "#a855f7", icon: "◐" },
            ].map((card) => (
              <div key={card.label} style={{
                background: "#1a2540",
                borderRadius: 12,
                padding: "18px 20px",
                border: "1px solid #1e293b",
                position: "relative",
                overflow: "hidden",
              }}>
                <div style={{
                  position: "absolute", top: 0, left: 0, right: 0, height: 3,
                  background: `linear-gradient(90deg, ${card.accent}, transparent)`,
                  borderRadius: "12px 12px 0 0",
                }} />
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: "#64748b", fontWeight: 500 }}>{card.label}</span>
                  <span style={{
                    width: 32, height: 32, borderRadius: 8, fontSize: 14,
                    background: `${card.accent}22`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: card.accent,
                  }}>{card.icon}</span>
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: -1 }}>{card.value}</div>
                <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>{card.sub}</div>
              </div>
            ))}
          </div>

          {/* Two column layout */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20 }}>

            {/* Leaderboard */}
            <div style={{ background: "#1a2540", borderRadius: 12, border: "1px solid #1e293b", overflow: "hidden" }}>
              <div style={{
                padding: "16px 20px", borderBottom: "1px solid #1e293b",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 8,
                    background: "#f59e0b22", display: "flex",
                    alignItems: "center", justifyContent: "center", fontSize: 14,
                  }}>◆</div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>HR Probability Leaderboard</span>
                </div>
                <span style={{ fontSize: 11, color: "#f59e0b", fontWeight: 600 }}>Live · Jul 1</span>
              </div>

              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#0f1a2e" }}>
                    {[["#", "40px"], ["Player", "auto"], ["Team", "80px"], ["Prob", "100px"], ["Trend", "60px"], ["HR", "50px"], ["BA", "60px"]].map(([h, w]) => (
                      <th key={h} style={{
                        padding: "10px 16px", textAlign: "left",
                        fontSize: 11, color: "#475569", fontWeight: 600, letterSpacing: 0.5,
                        width: w,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PLAYERS.map((p, i) => {
                    const probColor = p.prob >= 0.35 ? "#22c55e" : p.prob >= 0.25 ? "#f59e0b" : "#ef4444";
                    const medalColors = ["#f59e0b", "#94a3b8", "#cd7c3e"];
                    return (
                      <tr key={p.name} style={{
                        borderBottom: "1px solid #1e2a3e",
                        cursor: "pointer",
                        transition: "background 0.1s",
                      }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#0f1a2e88")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ padding: "12px 16px" }}>
                          <span style={{
                            fontSize: 13, fontWeight: 700,
                            color: i < 3 ? medalColors[i] : "#475569",
                          }}>{p.rank}</span>
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          <div style={{ fontWeight: 600, color: "#f1f5f9", fontSize: 13 }}>{p.name}</div>
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          <span style={{
                            fontSize: 11, fontWeight: 600, color: "#94a3b8",
                            background: "#1e293b", padding: "2px 7px", borderRadius: 4,
                          }}>{p.abbr}</span>
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ flex: 1, height: 4, background: "#0f172a", borderRadius: 2, overflow: "hidden" }}>
                              <div style={{
                                width: `${p.prob * 100}%`, height: "100%",
                                background: probColor, borderRadius: 2,
                              }} />
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 700, color: probColor, minWidth: 36 }}>
                              {(p.prob * 100).toFixed(1)}%
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: "12px 16px" }}><TrendBadge trend={p.trend} /></td>
                        <td style={{ padding: "12px 16px", fontSize: 13, color: "#e2e8f0", fontWeight: 600 }}>{p.hr}</td>
                        <td style={{ padding: "12px 16px", fontSize: 12, color: "#64748b" }}>{p.ba.toFixed(3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Right column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Today's Games */}
              <div style={{ background: "#1a2540", borderRadius: 12, border: "1px solid #1e293b" }}>
                <div style={{
                  padding: "14px 18px", borderBottom: "1px solid #1e293b",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Today's Games</span>
                  <span style={{
                    fontSize: 10, background: "#ef444422", color: "#ef4444",
                    padding: "3px 8px", borderRadius: 20, fontWeight: 700,
                  }}>2 LIVE</span>
                </div>
                <div style={{ padding: "8px 10px" }}>
                  {GAMES.map((g, i) => (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "9px 10px", borderRadius: 8, marginBottom: 4,
                      background: g.status === "live" ? "#ef44440a" : "transparent",
                      border: g.status === "live" ? "1px solid #ef444422" : "1px solid transparent",
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>
                        {g.away} <span style={{ color: "#475569", fontWeight: 400 }}>@</span> {g.home}
                      </div>
                      {g.status === "live" ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: "#ef4444" }}>
                            {g.awayScore}–{g.homeScore}
                          </span>
                          <span style={{
                            fontSize: 9, color: "#ef4444", border: "1px solid #ef444444",
                            padding: "1px 5px", borderRadius: 3, fontWeight: 700,
                          }}>{g.inning}</span>
                        </div>
                      ) : (
                        <span style={{ fontSize: 11, color: "#475569" }}>{g.time}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Top picks */}
              <div style={{ background: "#1a2540", borderRadius: 12, border: "1px solid #1e293b", flex: 1 }}>
                <div style={{ padding: "14px 18px", borderBottom: "1px solid #1e293b" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Top HR Picks Today</span>
                </div>
                <div style={{ padding: "12px 14px" }}>
                  {PLAYERS.slice(0, 5).map((p, i) => {
                    const probColor = p.prob >= 0.35 ? "#22c55e" : p.prob >= 0.25 ? "#f59e0b" : "#ef4444";
                    const conf = p.prob >= 0.35 ? "HIGH" : p.prob >= 0.25 ? "MED" : "LOW";
                    const confBg = p.prob >= 0.35 ? "#22c55e22" : p.prob >= 0.25 ? "#f59e0b22" : "#ef444422";
                    return (
                      <div key={p.name} style={{
                        display: "flex", alignItems: "center", gap: 12,
                        padding: "9px 0",
                        borderBottom: i < 4 ? "1px solid #1e293b" : "none",
                      }}>
                        <ProbArc value={p.prob} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9", marginBottom: 2 }}>
                            {p.name}
                          </div>
                          <div style={{ fontSize: 11, color: "#475569" }}>{p.abbr} · {p.hr} HR</div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                          <TrendBadge trend={p.trend} />
                          <span style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                            color: probColor, background: confBg,
                            padding: "2px 6px", borderRadius: 4,
                          }}>{conf} CONF</span>
                        </div>
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
