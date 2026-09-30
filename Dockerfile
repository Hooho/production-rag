FROM python:3.11-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libmagic1 libgl1 libglib2.0-0 poppler-utils tesseract-ocr tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 300 --retries 10 -r requirements.txt
RUN useradd --create-home app \
    && mkdir -p uploads /home/app/.cache \
    && chown -R app:app /app /home/app
COPY scripts ./scripts
RUN python scripts/bootstrap_nltk.py /usr/local/share/nltk_data
COPY app ./app
# 数据库迁移脚本，由 compose 的 migrate 服务在 API 和 Worker 启动前执行。
COPY alembic.ini ./
COPY migrations ./migrations
# 部分仓库源文件权限仅允许宿主用户读取，复制后仍由 root 持有会导致非 root 的 app 用户无法导入代码；复制完成后重新交给运行用户，保证 API 和 Worker 都能启动。
RUN chown -R app:app /app /home/app
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--limit-concurrency", "32"]
