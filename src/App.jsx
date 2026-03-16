import { useState, useMemo, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Area, AreaChart, BarChart, Bar, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── Calculation Engine (exact spreadsheet logic) ─────────────────────────────

function runModel(a) {
  const years = a.timeHorizon;
  const EPS = 0.01;

  const r = a.mortgageRate;
  const n = a.remainingTerm;
  const annualPmt = a.mortgageRepayment && r > 0 && n > 0
    ? a.outstandingMortgage * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
    : (a.mortgageRepayment ? a.outstandingMortgage / n : 0);

  const rental = [];
  let propValue = a.currentMarketValue;
  let prev_rISA_growth = 0, prev_rISA_close = 0;

  for (let y = 0; y <= years; y++) {
    let monthlyRent = 0, annualRent = 0, rentalCosts = 0;
    let mortInterest = 0, mortPrincipal = 0, taxPayable = 0, netCashflow = 0;
    let mortBal;

    if (y > 0) {
      monthlyRent = a.monthlyRent * Math.pow(1 + a.rentIncrease, y - 1);
      annualRent = monthlyRent * 12;
      rentalCosts = annualRent * (a.lettingAgentFee + a.maintenancePct) + a.otherAnnualCosts;
      const prevBal = rental[y - 1].mortBal;
      mortInterest = prevBal > EPS ? Math.max(0, prevBal * a.mortgageRate) : 0;
      if (mortInterest > EPS) {
        mortPrincipal = a.mortgageRepayment ? annualPmt - mortInterest : 0;
      }
      taxPayable = Math.max(0, (annualRent - rentalCosts) * a.rentalIncomeTaxRate - mortInterest * a.mortgageInterestCredit);
      netCashflow = annualRent - rentalCosts - mortInterest - mortPrincipal - taxPayable;
      propValue = rental[y - 1].propValue * (1 + a.propertyGrowth);
      mortBal = Math.max(0, rental[y - 1].mortBal - mortPrincipal);
    } else {
      mortBal = a.outstandingMortgage;
    }

    const equity = propValue - mortBal;
    const sellingCosts = propValue * a.sellingCostsPct;
    const netProceeds = propValue * (1 - a.sellingCostsPct) - (a.purchasePrice + a.purchaseCosts);
    const monthsSince = 12 * y;
    const totalMonths = 12 * (2026 - 2014 + y);
    const timeFactor = Math.max(0, monthsSince - 9) / totalMonths;
    const cgt = Math.max(0, (netProceeds * timeFactor - a.cgtAllowance) * a.cgtRate);
    const afterTaxEquity = equity - sellingCosts - cgt;

    let rISA_open, rISA_contrib = 0, rISA_growth, rISA_close;
    if (y === 0) {
      rISA_open = a.isaStartingValue;
      rISA_close = rISA_open;
      rISA_growth = 0;
    } else {
      rISA_open = y <= 8 ? prev_rISA_growth : prev_rISA_close;
      rISA_contrib = Math.min(Math.max(0, netCashflow), a.isaAllowance);
      rISA_growth = (rISA_open + rISA_contrib) * (a.isaGrowth - a.isaPlatformFees);
      rISA_close = rISA_open + rISA_contrib + rISA_growth;
    }
    prev_rISA_growth = rISA_growth;
    prev_rISA_close = rISA_close;

    rental.push({
      year: y, propValue, mortBal, equity, sellingCosts, cgt, afterTaxEquity,
      monthlyRent, annualRent, rentalCosts, mortInterest, mortPrincipal,
      taxPayable, netCashflow, isaClose: rISA_close, totalValue: afterTaxEquity + rISA_close
    });
  }

  // === GIA + ISA + SIPP PATH ===
  const netGrowth = a.isaGrowth - a.isaPlatformFees;
  const sippNetGrowth = a.sippGrowth - a.sippPlatformFees;
  const unusedAllowance = a.sippContribution * 3 / (1 - a.sippTaxRelief + 0.2);
  const giaStart = a.currentMarketValue * (1 - a.sellingCostsPct) - a.outstandingMortgage;

  const invest = [];
  let giaCostBasis = giaStart;
  let prevGiaAfterTax = giaStart;
  let prevISAClose = a.isaStartingValue;
  let prevSIPPClose = a.sippStartingValue;
  let prevSippGross = 0;

  for (let y = 0; y <= years; y++) {
    if (y === 0) {
      invest.push({
        year: 0, giaAfterTax: giaStart, isaClose: a.isaStartingValue,
        sippClose: a.sippStartingValue,
        afterTaxSipp: a.sippStartingValue * (1 - 0.75 * a.sippWithdrawalTax),
        totalValue: giaStart + a.isaStartingValue + a.sippStartingValue
      });
      continue;
    }

    const giaOpen = prevGiaAfterTax;
    let giaContrib;
    if (y === 1) {
      const maxW = a.isaContribution + a.sippContribution + unusedAllowance * (1 - a.sippTaxRelief + 0.2);
      giaContrib = -Math.min(giaOpen, maxW);
    } else {
      giaContrib = -Math.min(giaOpen, a.isaContribution + a.sippContribution);
    }

    const giaGrowthVal = (giaOpen + giaContrib) * netGrowth;
    const giaClose = giaOpen + giaContrib + giaGrowthVal;
    let newCostBasis = giaOpen > EPS ? giaCostBasis + giaContrib * (giaCostBasis / giaOpen) : 0;
    const giaCGT = Math.max(0, (giaClose - newCostBasis - a.cgtAllowance) * a.cgtRate);
    const sippRebate = y === 1 ? 0 : prevSippGross * (a.sippTaxRelief - 0.2);
    const giaAfterTax = giaClose - giaCGT + sippRebate;

    const isaContribVal = (-giaContrib > a.isaAllowance) ? a.isaContribution : -giaContrib;
    const isaOpen = prevISAClose;
    const isaGrowthVal = (isaOpen + isaContribVal) * netGrowth;
    const isaClose = isaOpen + isaContribVal + isaGrowthVal;

    const sippNet = -giaContrib - isaContribVal;
    const sippGross = sippNet / (1 - a.sippTaxRelief + 0.2);
    const sippOpen = prevSIPPClose;
    const sippGrowthVal = (sippOpen + sippGross) * sippNetGrowth;
    const sippClose = sippOpen + sippGross + sippGrowthVal;
    const afterTaxSipp = sippClose * (1 - 0.75 * a.sippWithdrawalTax);
    const totalValue = giaAfterTax + isaClose + sippClose;

    invest.push({ year: y, giaAfterTax, isaClose, sippClose, afterTaxSipp, totalValue });

    prevGiaAfterTax = giaAfterTax;
    giaCostBasis = newCostBasis;
    prevISAClose = isaClose;
    prevSIPPClose = sippClose;
    prevSippGross = sippGross;
  }

  const comparison = rental.map((rr, i) => ({
    year: rr.year,
    rentalTotal: Math.round(rr.totalValue),
    investTotal: Math.round(invest[i].totalValue),
    difference: Math.round(invest[i].totalValue - rr.totalValue),
    propertyValue: Math.round(rr.propValue),
    mortgageBalance: Math.round(rr.mortBal),
    rentalEquity: Math.round(rr.afterTaxEquity),
    rentalISA: Math.round(rr.isaClose),
    giaBalance: Math.round(invest[i].giaAfterTax),
    isaBalance: Math.round(invest[i].isaClose),
    sippBalance: Math.round(invest[i].sippClose),
    afterTaxSipp: Math.round(invest[i].afterTaxSipp),
    netCashflow: Math.round(rr.netCashflow),
  }));

  return { rental, invest, comparison };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (v) => {
  if (Math.abs(v) >= 1e6) return `£${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `£${(v / 1e3).toFixed(0)}k`;
  return `£${v.toFixed(0)}`;
};
const fmtFull = (v) => `£${Math.round(v).toLocaleString()}`;

function Slider({ label, value, onChange, min, max, step, format = "currency" }) {
  const display = format === "percent" ? `${(value * 100).toFixed(1)}%`
    : format === "currency" ? `£${value.toLocaleString()}`
    : format === "years" ? `${value} yrs` : `${value}`;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#94a3b8", fontFamily: "'DM Sans', sans-serif", letterSpacing: "0.02em" }}>{label}</span>
        <span style={{ fontSize: 13, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "#6366f1", height: 4, cursor: "pointer" }} />
    </div>
  );
}

function StatCard({ label, value, sublabel, color = "#6366f1", icon }) {
  return (
    <div style={{
      background: "rgba(30,27,46,0.7)", backdropFilter: "blur(20px)",
      border: "1px solid rgba(99,102,241,0.15)", borderRadius: 16, padding: "20px 22px", flex: 1, minWidth: 180,
    }}>
      <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "'DM Sans', sans-serif", marginBottom: 8 }}>
        {icon && <span style={{ marginRight: 6 }}>{icon}</span>}{label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.02em" }}>{value}</div>
      {sublabel && <div style={{ fontSize: 11, color: "#64748b", marginTop: 4, fontFamily: "'DM Sans', sans-serif" }}>{sublabel}</div>}
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "rgba(15,14,28,0.95)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 12, padding: "14px 18px", backdropFilter: "blur(20px)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8, fontFamily: "'DM Sans', sans-serif" }}>Year {label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.color }} />
          <span style={{ fontSize: 12, color: "#cbd5e1", fontFamily: "'DM Sans', sans-serif", flex: 1 }}>{p.name}</span>
          <span style={{ fontSize: 13, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{fmtFull(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function SectionHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: "#e2e8f0", fontFamily: "'Playfair Display', serif", margin: 0 }}>{title}</h2>
      {subtitle && <p style={{ fontSize: 13, color: "#64748b", margin: "4px 0 0", fontFamily: "'DM Sans', sans-serif" }}>{subtitle}</p>}
    </div>
  );
}

function Tabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, background: "rgba(15,14,28,0.6)", borderRadius: 12, padding: 4, marginBottom: 24 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          flex: 1, padding: "10px 16px", border: "none", borderRadius: 10, fontSize: 13,
          fontFamily: "'DM Sans', sans-serif", fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
          background: active === t.id ? "rgba(99,102,241,0.2)" : "transparent",
          color: active === t.id ? "#a5b4fc" : "#64748b", outline: "none",
        }}>{t.label}</button>
      ))}
    </div>
  );
}

const C = { rental: "#f59e0b", invest: "#6366f1", property: "#f59e0b", mortgage: "#ef4444", equity: "#22c55e", gia: "#94a3b8", isa: "#6366f1", sipp: "#8b5cf6", difference: "#34d399" };

const defaults = {
  timeHorizon: 25,
  marginalTaxRate: 0.4, rentalIncomeTaxRate: 0.42, cgtRate: 0.24, cgtAllowance: 3000,
  mortgageInterestCredit: 0.2, purchasePrice: 355000, purchaseCosts: 12800,
  currentMarketValue: 380000, outstandingMortgage: 70000, mortgageRate: 0.04,
  remainingTerm: 7, mortgageRepayment: true, monthlyRent: 1800, rentIncrease: 0.02,
  propertyGrowth: 0.03, lettingAgentFee: 0.10, maintenancePct: 0.03,
  otherAnnualCosts: 1500, sellingCostsPct: 0.025, isaStartingValue: 0,
  isaContribution: 20000, isaAllowance: 20000, isaGrowth: 0.06, isaPlatformFees: 0.005,
  sippStartingValue: 0, sippContribution: 20000, sippAllowance: 60000,
  sippGrowth: 0.06, sippPlatformFees: 0.005, sippTaxRelief: 0.4, sippWithdrawalTax: 0.2,
};

export default function App() {
  const [a, setA] = useState(defaults);
  const [tab, setTab] = useState("overview");
  const [panelOpen, setPanelOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const up = useCallback((k) => (v) => setA(p => ({ ...p, [k]: v })), []);

  const { comparison } = useMemo(() => runModel(a), [a]);

  const last = comparison[comparison.length - 1];
  const winner = last.investTotal > last.rentalTotal ? "ISA+SIPP" : "Property";
  const winColor = winner === "ISA+SIPP" ? "#34d399" : "#f59e0b";
  const crossover = comparison.find((d, i) => i > 0 && d.investTotal > d.rentalTotal)?.year;

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #0c0b1d 0%, #12112b 40%, #0e0d20 100%)", color: "#e2e8f0", fontFamily: "'DM Sans', sans-serif", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "fixed", top: -200, right: -200, width: 600, height: 600, background: "radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: -300, left: -200, width: 700, height: 700, background: "radial-gradient(circle, rgba(245,158,11,0.05) 0%, transparent 70%)", pointerEvents: "none" }} />
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`
        input[type=range]{-webkit-appearance:none;appearance:none;background:rgba(99,102,241,0.15);border-radius:4px;outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#6366f1;cursor:pointer;box-shadow:0 0 12px rgba(99,102,241,0.5)}
        input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#6366f1;cursor:pointer;border:none}
        *{box-sizing:border-box}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(99,102,241,0.3);border-radius:3px}
      `}</style>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 24px", position: "relative", zIndex: 1 }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.2em", color: "#6366f1", marginBottom: 8, fontWeight: 600 }}>Investment Comparison Tool</div>
          <h1 style={{ fontSize: "clamp(28px, 4vw, 42px)", fontWeight: 800, fontFamily: "'Playfair Display', serif", margin: 0, background: "linear-gradient(135deg, #e2e8f0, #a5b4fc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", lineHeight: 1.2 }}>Rental Property vs ISA + SIPP</h1>
          <p style={{ color: "#64748b", fontSize: 14, marginTop: 8, maxWidth: 600, marginLeft: "auto", marginRight: "auto" }}>Compare holding a buy-to-let against selling and investing in a GIA, ISA and SIPP over {a.timeHorizon} years.</p>
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 32 }}>
          <StatCard icon="🏠" label={`Property Path (Yr ${a.timeHorizon})`} value={fmt(last.rentalTotal)} sublabel="After-tax equity + surplus ISA" color={C.rental} />
          <StatCard icon="📈" label={`GIA+ISA+SIPP (Yr ${a.timeHorizon})`} value={fmt(last.investTotal)} sublabel="GIA + ISA + SIPP (gross)" color={C.invest} />
          <StatCard icon="⚡" label="Difference" value={`${last.difference > 0 ? "+" : ""}${fmt(last.difference)}`} sublabel={`${winner} wins${crossover ? ` · Crossover yr ${crossover}` : ""}`} color={winColor} />
          <StatCard icon="🎯" label="Winner" value={winner} sublabel={`Over ${a.timeHorizon}-year horizon`} color={winColor} />
        </div>

        <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ width: panelOpen ? 320 : 48, flexShrink: 0, transition: "width 0.3s ease", position: "relative" }}>
            <button onClick={() => setPanelOpen(!panelOpen)} style={{ position: "absolute", top: 12, right: panelOpen ? 12 : 6, zIndex: 10, background: "rgba(99,102,241,0.2)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 8, width: 32, height: 32, cursor: "pointer", color: "#a5b4fc", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>{panelOpen ? "◀" : "▶"}</button>
            {panelOpen && (
              <div style={{ background: "rgba(20,18,38,0.8)", backdropFilter: "blur(24px)", border: "1px solid rgba(99,102,241,0.12)", borderRadius: 20, padding: "24px 20px", overflowY: "auto", maxHeight: "calc(100vh - 120px)", position: "sticky", top: 20 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: "#a5b4fc", margin: "0 0 16px", textTransform: "uppercase", letterSpacing: "0.1em" }}>Assumptions</h3>
                <Slider label="Time Horizon" value={a.timeHorizon} onChange={up("timeHorizon")} min={5} max={40} step={1} format="years" />
                <div style={{ height: 1, background: "rgba(99,102,241,0.15)", margin: "16px 0" }} />

                <div style={{ fontSize: 11, color: "#6366f1", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Property</div>
                <Slider label="Purchase Price" value={a.purchasePrice} onChange={up("purchasePrice")} min={50000} max={1500000} step={5000} />
                <Slider label="Purchase Costs" value={a.purchaseCosts} onChange={up("purchaseCosts")} min={0} max={50000} step={500} />
                <Slider label="Current Market Value" value={a.currentMarketValue} onChange={up("currentMarketValue")} min={50000} max={1500000} step={5000} />
                <Slider label="Outstanding Mortgage" value={a.outstandingMortgage} onChange={up("outstandingMortgage")} min={0} max={500000} step={5000} />
                <Slider label="Mortgage Rate" value={a.mortgageRate} onChange={up("mortgageRate")} min={0.01} max={0.1} step={0.0025} format="percent" />
                <Slider label="Remaining Term" value={a.remainingTerm} onChange={up("remainingTerm")} min={1} max={30} step={1} format="years" />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                  <span style={{ fontSize: 12, color: "#94a3b8", fontFamily: "'DM Sans', sans-serif" }}>Mortgage Type</span>
                  <button onClick={() => up("mortgageRepayment")(!a.mortgageRepayment)} style={{
                    padding: "4px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                    fontFamily: "'JetBrains Mono', monospace", border: "1px solid rgba(99,102,241,0.3)",
                    background: a.mortgageRepayment ? "rgba(99,102,241,0.2)" : "rgba(245,158,11,0.2)",
                    color: a.mortgageRepayment ? "#a5b4fc" : "#fbbf24",
                  }}>{a.mortgageRepayment ? "Repayment" : "Interest Only"}</button>
                </div>
                <Slider label="Monthly Rent" value={a.monthlyRent} onChange={up("monthlyRent")} min={500} max={5000} step={50} />
                <Slider label="Rent Increase" value={a.rentIncrease} onChange={up("rentIncrease")} min={0} max={0.1} step={0.005} format="percent" />
                <Slider label="Property Growth" value={a.propertyGrowth} onChange={up("propertyGrowth")} min={0} max={0.1} step={0.005} format="percent" />
                <Slider label="Letting Agent Fee" value={a.lettingAgentFee} onChange={up("lettingAgentFee")} min={0} max={0.15} step={0.01} format="percent" />
                <Slider label="Maintenance" value={a.maintenancePct} onChange={up("maintenancePct")} min={0} max={0.1} step={0.005} format="percent" />
                <Slider label="Other Annual Costs" value={a.otherAnnualCosts} onChange={up("otherAnnualCosts")} min={0} max={5000} step={100} />
                <Slider label="Selling Costs" value={a.sellingCostsPct} onChange={up("sellingCostsPct")} min={0} max={0.05} step={0.005} format="percent" />

                <div style={{ fontSize: 11, color: "#6366f1", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10, marginTop: 16 }}>ISA & SIPP</div>
                <Slider label="ISA Starting Value" value={a.isaStartingValue} onChange={up("isaStartingValue")} min={0} max={500000} step={5000} />
                <Slider label="ISA Contribution" value={a.isaContribution} onChange={up("isaContribution")} min={0} max={20000} step={1000} />
                <Slider label="SIPP Starting Value" value={a.sippStartingValue} onChange={up("sippStartingValue")} min={0} max={500000} step={5000} />
                <Slider label="SIPP Contribution (Net)" value={a.sippContribution} onChange={up("sippContribution")} min={0} max={40000} step={1000} />
                <Slider label="Growth Rate" value={a.isaGrowth} onChange={(v) => { up("isaGrowth")(v); up("sippGrowth")(v); }} min={0.02} max={0.12} step={0.005} format="percent" />
                <Slider label="Platform Fees" value={a.isaPlatformFees} onChange={(v) => { up("isaPlatformFees")(v); up("sippPlatformFees")(v); }} min={0} max={0.02} step={0.001} format="percent" />

                <div style={{ fontSize: 11, color: "#6366f1", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10, marginTop: 16 }}>Tax Rates</div>
                <Slider label="Rental Income Tax" value={a.rentalIncomeTaxRate} onChange={up("rentalIncomeTaxRate")} min={0.2} max={0.45} step={0.01} format="percent" />
                <Slider label="CGT Rate" value={a.cgtRate} onChange={up("cgtRate")} min={0.1} max={0.3} step={0.01} format="percent" />
                <Slider label="SIPP Tax Relief" value={a.sippTaxRelief} onChange={up("sippTaxRelief")} min={0.2} max={0.45} step={0.01} format="percent" />
                <Slider label="SIPP Withdrawal Tax" value={a.sippWithdrawalTax} onChange={up("sippWithdrawalTax")} min={0} max={0.4} step={0.01} format="percent" />

                {/* Advanced / HMRC Section */}
                <div style={{ height: 1, background: "rgba(99,102,241,0.15)", margin: "16px 0" }} />
                <button onClick={() => setAdvancedOpen(!advancedOpen)} style={{
                  width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "8px 0", background: "none", border: "none", cursor: "pointer", outline: "none",
                }}>
                  <span style={{ fontSize: 11, color: "#6366f1", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em" }}>Advanced / HMRC Limits</span>
                  <span style={{ color: "#6366f1", fontSize: 14, transition: "transform 0.2s", transform: advancedOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▼</span>
                </button>
                {advancedOpen && (
                  <div style={{ marginTop: 10 }}>
                    <Slider label="CGT Allowance" value={a.cgtAllowance} onChange={up("cgtAllowance")} min={0} max={12000} step={500} />
                    <Slider label="Mortgage Interest Credit" value={a.mortgageInterestCredit} onChange={up("mortgageInterestCredit")} min={0} max={0.4} step={0.01} format="percent" />
                    <Slider label="ISA Annual Allowance" value={a.isaAllowance} onChange={up("isaAllowance")} min={0} max={40000} step={1000} />
                    <Slider label="SIPP Annual Allowance" value={a.sippAllowance} onChange={up("sippAllowance")} min={0} max={100000} step={5000} />
                    <Slider label="Marginal Income Tax" value={a.marginalTaxRate} onChange={up("marginalTaxRate")} min={0.2} max={0.45} step={0.01} format="percent" />
                  </div>
                )}

                <button onClick={() => setA(defaults)} style={{ width: "100%", marginTop: 16, padding: "10px", borderRadius: 10, background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)", color: "#a5b4fc", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>Reset to Defaults</button>
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <Tabs tabs={[{ id: "overview", label: "Overview" }, { id: "property", label: "Property Detail" }, { id: "invest", label: "GIA+ISA+SIPP" }, { id: "cashflow", label: "Cashflow" }]} active={tab} onChange={setTab} />

            {tab === "overview" && (<>
              <div style={{ background: "rgba(20,18,38,0.6)", backdropFilter: "blur(20px)", border: "1px solid rgba(99,102,241,0.12)", borderRadius: 20, padding: "28px 24px", marginBottom: 24 }}>
                <SectionHeader title="Total Wealth Comparison" subtitle={`Value of each strategy over ${a.timeHorizon} years`} />
                <ResponsiveContainer width="100%" height={380}>
                  <AreaChart data={comparison} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gR" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.rental} stopOpacity={0.3} /><stop offset="100%" stopColor={C.rental} stopOpacity={0} /></linearGradient>
                      <linearGradient id="gI" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.invest} stopOpacity={0.3} /><stop offset="100%" stopColor={C.invest} stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.08)" />
                    <XAxis dataKey="year" stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tickFormatter={fmt} stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} width={65} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="rentalTotal" name="Property Path" stroke={C.rental} fill="url(#gR)" strokeWidth={2.5} dot={false} />
                    <Area type="monotone" dataKey="investTotal" name="GIA+ISA+SIPP" stroke={C.invest} fill="url(#gI)" strokeWidth={2.5} dot={false} />
                    {crossover && <ReferenceLine x={crossover} stroke="rgba(52,211,153,0.4)" strokeDasharray="5 5" />}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: "rgba(20,18,38,0.6)", backdropFilter: "blur(20px)", border: "1px solid rgba(99,102,241,0.12)", borderRadius: 20, padding: "28px 24px" }}>
                <SectionHeader title="Advantage (GIA+ISA+SIPP − Property)" subtitle="Positive = investment path ahead" />
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={comparison.slice(1)} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.08)" />
                    <XAxis dataKey="year" stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tickFormatter={fmt} stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} width={65} />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine y={0} stroke="rgba(148,163,184,0.3)" />
                    <Bar dataKey="difference" name="Difference" radius={[4, 4, 0, 0]} fill={C.difference} opacity={0.8} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>)}

            {tab === "property" && (
              <div style={{ background: "rgba(20,18,38,0.6)", backdropFilter: "blur(20px)", border: "1px solid rgba(99,102,241,0.12)", borderRadius: 20, padding: "28px 24px" }}>
                <SectionHeader title="Property Path Breakdown" subtitle="Property value, mortgage, after-tax equity and surplus ISA" />
                <ResponsiveContainer width="100%" height={400}>
                  <AreaChart data={comparison} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gP" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.property} stopOpacity={0.2} /><stop offset="100%" stopColor={C.property} stopOpacity={0} /></linearGradient>
                      <linearGradient id="gE" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.equity} stopOpacity={0.2} /><stop offset="100%" stopColor={C.equity} stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.08)" />
                    <XAxis dataKey="year" stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tickFormatter={fmt} stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} width={65} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="propertyValue" name="Property Value" stroke={C.property} fill="url(#gP)" strokeWidth={2} dot={false} />
                    <Area type="monotone" dataKey="rentalEquity" name="After-Tax Equity" stroke={C.equity} fill="url(#gE)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="mortgageBalance" name="Mortgage" stroke={C.mortgage} strokeWidth={2} dot={false} strokeDasharray="6 3" />
                    <Line type="monotone" dataKey="rentalISA" name="Surplus ISA" stroke={C.isa} strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {tab === "invest" && (
              <div style={{ background: "rgba(20,18,38,0.6)", backdropFilter: "blur(20px)", border: "1px solid rgba(99,102,241,0.12)", borderRadius: 20, padding: "28px 24px" }}>
                <SectionHeader title="GIA + ISA + SIPP Breakdown" subtitle="GIA drawdown into tax-efficient ISA and SIPP wrappers" />
                <ResponsiveContainer width="100%" height={400}>
                  <AreaChart data={comparison} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gIS" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.isa} stopOpacity={0.3} /><stop offset="100%" stopColor={C.isa} stopOpacity={0} /></linearGradient>
                      <linearGradient id="gSP" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.sipp} stopOpacity={0.3} /><stop offset="100%" stopColor={C.sipp} stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.08)" />
                    <XAxis dataKey="year" stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tickFormatter={fmt} stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} width={65} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="sippBalance" name="SIPP (gross)" stroke={C.sipp} fill="url(#gSP)" strokeWidth={2} dot={false} />
                    <Area type="monotone" dataKey="isaBalance" name="ISA" stroke={C.isa} fill="url(#gIS)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="giaBalance" name="GIA (after tax)" stroke={C.gia} strokeWidth={2} dot={false} strokeDasharray="6 3" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {tab === "cashflow" && (
              <div style={{ background: "rgba(20,18,38,0.6)", backdropFilter: "blur(20px)", border: "1px solid rgba(99,102,241,0.12)", borderRadius: 20, padding: "28px 24px" }}>
                <SectionHeader title="Annual Net Rental Cashflow" subtitle="Rental income minus costs, mortgage, and tax" />
                <ResponsiveContainer width="100%" height={400}>
                  <BarChart data={comparison.slice(1)} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.08)" />
                    <XAxis dataKey="year" stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tickFormatter={fmt} stroke="#475569" tick={{ fontSize: 11, fill: "#64748b" }} width={65} />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine y={0} stroke="rgba(148,163,184,0.3)" />
                    <Bar dataKey="netCashflow" name="Net Cashflow" radius={[4, 4, 0, 0]} fill="#22c55e" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            <div style={{ background: "rgba(20,18,38,0.6)", backdropFilter: "blur(20px)", border: "1px solid rgba(99,102,241,0.12)", borderRadius: 20, padding: "28px 24px", marginTop: 24, overflowX: "auto" }}>
              <SectionHeader title="Year-by-Year Summary" />
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(99,102,241,0.2)" }}>
                    {["Year", "Property Path", "GIA+ISA+SIPP", "Difference"].map(h => (
                      <th key={h} style={{ padding: "10px 12px", textAlign: "right", color: "#64748b", fontWeight: 600, fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparison.filter((_, i) => i % 5 === 0 || i === comparison.length - 1).map(d => (
                    <tr key={d.year} style={{ borderBottom: "1px solid rgba(99,102,241,0.06)" }}>
                      <td style={{ padding: "8px 12px", textAlign: "right", color: "#94a3b8" }}>{d.year}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", color: C.rental }}>{fmtFull(d.rentalTotal)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", color: C.invest }}>{fmtFull(d.investTotal)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", color: d.difference >= 0 ? "#34d399" : "#f87171" }}>{d.difference >= 0 ? "+" : ""}{fmtFull(d.difference)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
