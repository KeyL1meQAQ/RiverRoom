FROM node:24-alpine AS web
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM python:3.12-slim AS odds
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/build_odds.py backend/runout_odds.c ./backend/
RUN python -m backend.build_odds

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend ./backend
COPY --from=odds /app/backend/_runout_odds.so ./backend/_runout_odds.so
COPY --from=web /app/dist ./dist
RUN useradd --create-home poker && chown -R poker:poker /app
USER poker
EXPOSE 8000
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
