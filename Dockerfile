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
# NLTK 资源要从 GitHub 下载。以前先 COPY 整个 scripts 目录再下载，scripts 里任何一个文件改了（比如导出脚本），
# 这一层缓存就失效、要重新下载，国内网络经常在这一步失败；现在只复制下载脚本本身，它不改就一直用缓存。
# GitHub 访问不了时：.env 里填 HTTP_PROXY / HTTPS_PROXY（compose 会作为构建参数传进来），
# 或者用 NLTK_DATA_BASE_URL 换成镜像地址（指向 nltk_data 仓库 gh-pages 分支的 packages 目录）。
ARG NLTK_DATA_BASE_URL=https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages
COPY scripts/bootstrap_nltk.py ./scripts/bootstrap_nltk.py
RUN NLTK_DATA_BASE_URL=$NLTK_DATA_BASE_URL python scripts/bootstrap_nltk.py /usr/local/share/nltk_data
COPY scripts ./scripts
COPY app ./app
# 数据库迁移脚本，由 compose 的 migrate 服务在 API 和 Worker 启动前执行。
COPY alembic.ini ./
COPY migrations ./migrations
# 部分仓库源文件权限仅允许宿主用户读取，复制后仍由 root 持有会导致非 root 的 app 用户无法导入代码；复制完成后重新交给运行用户，保证 API 和 Worker 都能启动。
RUN chown -R app:app /app /home/app
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--limit-concurrency", "32"]
