FROM node:22-alpine AS contract-build

WORKDIR /build

RUN npm install --global cashc@0.14.0

COPY backend/contracts/HodlVault.cash ./contracts/HodlVault.cash
COPY backend/contracts/ChallengeVault.cash ./contracts/ChallengeVault.cash

RUN mkdir -p /artifacts \
    && cashc ./contracts/HodlVault.cash \
       --output /artifacts/HodlVault.json \
    && cashc ./contracts/ChallengeVault.cash \
       --output /artifacts/ChallengeVault.json

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=3000 \
    BCH_NETWORK=chipnet \
    UNLOCK_TIME=1893456000 \
    ARTIFACT_PATH=/app/artifacts/HodlVault.json

WORKDIR /app

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/main.py .
COPY backend/reward_broadcast.py .
COPY backend/challenge_vault.py .
COPY public/craft-preview.png /app/craft-preview.png
COPY --from=contract-build /artifacts/HodlVault.json /app/artifacts/HodlVault.json
COPY --from=contract-build /artifacts/ChallengeVault.json /app/artifacts/ChallengeVault.json

USER app

EXPOSE 3000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
