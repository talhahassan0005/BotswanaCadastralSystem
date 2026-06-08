# Botswana Cadastral Survey System

Web-based cadastral data-processing software for Botswana land surveyors: import survey data,
run COGO + traverse adjustment, validate accuracy against DSM limits, construct parcels, and
generate SG Diagrams / General Plans / Working Plans.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full design and phased roadmap.

## Architecture (hybrid)

```
Next.js + Tailwind (web)  ─►  Express + MongoDB (api)  ─►  Python + FastAPI (engine)
        UI                     system-of-record + orchestration     survey math
```

- **apps/web** — Next.js 14 (App Router) + Tailwind UI. Tabs: Data Import, COGO Engine,
  Traverse, Parcels, Diagrams, GIS Map, Export, AI Validate.
- **apps/api** — Express + Mongoose. Orchestrates the engine, parses CSV, runs validation,
  generates AI narratives via Groq. Runs even without MongoDB (stateless mode).
- **services/engine** — Python compute engine: COGO (traverse, inverse, intersection, area,
  curves), Bowditch/Transit adjustment, closure metrics. **17 unit tests pass.**

## Prerequisites

- Node.js 20+ and npm
- Python 3.10+
- (optional) MongoDB — persistence is disabled gracefully if absent

## Setup

```bash
# 1. Secrets — already created as .env (git-ignored). Rotate the Groq key.
cp .env.example .env   # if you don't have one

# 2. Node deps (installs all workspaces)
npm install

# 3. Python engine deps
cd services/engine
py -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # macOS/Linux
cd ../..
```

## Run (three terminals, or use the combined script)

```bash
# Engine  (http://localhost:8000)
cd services/engine && .venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# API     (http://localhost:4000)
npm run dev:api

# Web     (http://localhost:3000)
npm run dev:web
```

Or all at once after `npm install`: `npm run dev`.

## Try it

1. Open http://localhost:3000 → **Data Import** → "Load sample".
2. **Proceed to COGO** → choose Closed Traverse + Bowditch → **Run COGO Computation**.
3. **AI Validate** → **Run AI Validation** for DSM checks + an AI survey report.

## Tests

```bash
npm run test:engine     # Python COGO unit tests
```

## Status

Live now: COGO engine, Data Import, COGO Engine screen, AI Validate.
Planned (see ARCHITECTURE.md): coordinate-system transforms, parcel construction,
diagram/plan generation, exports (PDF/DXF/SHP/DWG), GIS map.
