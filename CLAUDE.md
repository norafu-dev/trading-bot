# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Structure

Monorepo with two packages managed via pnpm workspaces:

- `dashboard/` — Next.js 15 frontend (React 19, Tailwind CSS v4)
- `signal/` — Hono backend API service (Node.js, TypeScript)
- `reference/` — External OpenAlice reference implementation (read-only reference)

## Commands

### Dashboard (`cd dashboard`)
```bash
pnpm dev      # Start Next.js dev server
pnpm build    # Production build
pnpm lint     # Run ESLint
```

### Signal (`cd signal`)
```bash
pnpm dev      # Start Hono server with tsx watch (hot reload)
pnpm build    # Compile TypeScript to dist/
pnpm start    # Run compiled dist/index.js
```

## Architecture

**Dashboard** is a Next.js app under `dashboard/app/` using the App Router. Styling is Tailwind CSS v4 with PostCSS. The entry page is `app/page.tsx`.

**Signal** is a Hono web service (`signal/src/index.ts`) running on port 3000 via `@hono/node-server`. It serves as the trading signal API backend.

## Important: Next.js Version

This project uses **Next.js 15** with the App Router.
