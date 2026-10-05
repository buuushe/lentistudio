FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM web AS web-test
RUN npm run check

FROM python:3.12-slim AS server
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/requirements.txt ./
RUN pip install -r requirements.txt
COPY server/app ./app

FROM server AS server-test
COPY server/requirements-dev.txt server/pyproject.toml ./
RUN pip install -r requirements-dev.txt
COPY server/tests ./tests
RUN ruff check . && ruff format --check . && pytest -q

FROM server AS app
ENV DATA_DIR=/data \
    SPA_DIR=/app/web
COPY --from=web /web/dist ./web
RUN useradd --system --uid 1000 --create-home studio \
    && mkdir -p /data && chown studio:studio /data
USER studio
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
