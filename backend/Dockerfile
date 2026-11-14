FROM node:22-alpine AS contract-build

WORKDIR /build

RUN npm install --global cashc

COPY contracts/HodlVault.cash ./contracts/HodlVault.cash

RUN mkdir -p /artifacts \
    && cashc ./contracts/HodlVault.cash \
       --output /artifacts/HodlVault.json

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=3000 \
    BCH_NETWORK=chipnet \
    UNLOCK_TIME=1893456000 \
    ARTIFACT_PATH=/app/artifacts/HodlVault.json

WORKDIR /app

RUN addgroup --system app \
    && adduser --system --ingroup app app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY --from=contract-build /artifacts/HodlVault.json /app/artifacts/HodlVault.json

USER app

EXPOSE 3000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
