# Semantic Delta Detector

> Detect when two metrics look similar — but mean different things.

---

### Example

    Verdict: HIGH SEMANTIC CONFLICT
    Confidence: high
    Evidence: sql, metric_name, description, team_context

Same metric name. Different meaning. High confidence.

---

A CLI tool that detects **semantic differences between SQL queries** — before they break your metrics.

---

## 🚀 Demo

    corepack pnpm compare \
      --json-a ./src/examples/product-active-users.json \
      --json-b ./src/examples/finance-active-users.json \
      --demo

    Verdict: HIGH SEMANTIC CONFLICT
    Interchangeability: Not safely interchangeable
    Confidence: high
    Evidence: sql, metric_name, description, team_context, intended_use

👉 Same metric name. Different meaning. High confidence.

---

## 🧩 Features

- SQL semantic comparison
- Metadata-aware analysis (v2)
- Confidence scoring
- Evidence-based explanations
- Demo mode

---

## 🛠 Usage

### SQL mode

    corepack pnpm compare --file-a a.sql --file-b b.sql

### Metadata mode (v2)

    corepack pnpm compare --json-a metricA.json --json-b metricB.json

---

## 🧪 Example input

    {
      "metric_name": "active_users",
      "team_context": "product",
      "description": "Users who logged in during the last 30 days",
      "intended_use": "product dashboard",
      "query": "SELECT ..."
    }

---

## 🎯 Philosophy

- Not a governance platform
- Not a truth engine
- Just a **small, sharp tool** that catches semantic conflicts early

---

## 📦 Status

MVP with metadata-aware comparison (v2)
