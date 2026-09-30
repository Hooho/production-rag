FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
RUN useradd --create-home embed && mkdir -p /home/embed/.cache && chown -R embed:embed /app /home/embed
USER embed
ENV HF_HOME=/home/embed/.cache/huggingface
# fastembed 默认把模型下载到 /tmp/fastembed_cache，这个目录在容器里，不在 embedding_cache 卷里：
# 每次重建或重新创建容器，向量模型和重排模型（约 1 GB）都要重新下载。改到卷里的目录后只需下载一次。
ENV FASTEMBED_CACHE_PATH=/home/embed/.cache/fastembed
EXPOSE 8090
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
