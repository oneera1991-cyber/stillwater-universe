# Stillwater — พี่เวรา

A Next.js (App Router) web app for a mystical storytelling experience with the character "Pee Vera."

## Tech Stack

- **Next.js 14** (App Router) + TypeScript
- **Tailwind CSS** — dark atmospheric theme
- **baziflow-core** — Bazi (Eight Characters) astrology calculation
- **OpenAI / Anthropic** — AI narrative generation
- **Payhip** — payment links (Starter ฿19 / Deeper ฿59)

## Project Structure

```
stillwater/
├── app/
│   ├── layout.tsx          # Root layout + Google Fonts
│   ├── globals.css         # Tailwind + custom styles
│   ├── page.tsx            # / — Landing + question form
│   ├── choose/
│   │   └── page.tsx        # /choose — Package selection
│   ├── reading/
│   │   └── page.tsx        # /reading — Results display
│   └── api/reading/
│       └── route.ts        # POST /api/reading — backend logic
├── lib/
│   ├── cards.ts            # Stillwater card definitions + draw logic
│   ├── bazi.ts             # baziflow-core wrapper (graceful fallback)
│   └── ai.ts               # OpenAI / Anthropic caller
├── .env.local.example      # Environment variable template
└── tailwind.config.ts
```

## Setup

1. **Install dependencies**
   ```bash
   npm install
   # or
   yarn install
   ```

2. **Environment variables** — copy and fill in:
   ```bash
   cp .env.local.example .env.local
   ```
   Required variables:
   ```
   OPENAI_API_KEY=sk-...          # or ANTHROPIC_API_KEY
   AI_PROVIDER=openai             # "openai" or "anthropic"
   NEXT_PUBLIC_PAYHIP_STARTER_URL=https://payhip.com/b/YOUR_STARTER
   NEXT_PUBLIC_PAYHIP_DEEPER_URL=https://payhip.com/b/YOUR_DEEPER
   NEXT_PUBLIC_BASE_URL=https://yourdomain.com
   ```

3. **Payhip setup**
   - Create two products on [Payhip](https://payhip.com) (Starter ฿19, Deeper ฿59)
   - Set the "Redirect URL after purchase" to:
     - Starter → `https://yourdomain.com/reading?pack=starter`
     - Deeper  → `https://yourdomain.com/reading?pack=deeper`
   - Copy each product URL into `.env.local`

4. **Run dev server**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000)

## User Flow

```
/ (landing)
  └─ [พบพี่เวรา] → zoom animation + greeting
       └─ Fill question + birthdate (+ optional time)
            └─ [ส่งคำถาม] → /choose
                 ├─ [Starter ฿19] → Payhip → /reading?pack=starter
                 └─ [Deeper  ฿59] → Payhip → /reading?pack=deeper
                       └─ Vera reads cards + AI story displayed
```

## Backend Logic (`/api/reading`)

1. Receive `question`, `birthdate`, `birthtime`, `pack`, `language`
2. Draw cards — 1 for Starter, 3 for Deeper
3. If `birthdate` given → compute Bazi via `baziflow-core`
4. Build prompt with card essences + Bazi energy pattern
5. Call AI (OpenAI or Anthropic) as Pee Vera persona
6. Return `{ story, cards, pack }`

## Notes

- `baziflow-core` is dynamically imported — the app works even if the package is unavailable.
- Data is stored in `sessionStorage` between pages (no database needed for MVP).
- Language (Thai/English) is persisted via sessionStorage from the first page.
- Mobile-first responsive design.

## Deploy to Vercel

```bash
npx vercel
```
Add all `.env.local` variables to your Vercel project settings.
