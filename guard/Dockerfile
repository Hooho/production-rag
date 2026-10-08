FROM python:3.11-slim

WORKDIR /app
# 只装 CPU 版 PyTorch（约 200 MB）；默认的 PyPI 包带 CUDA，要几个 GB。
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
RUN useradd --create-home guard && mkdir -p /home/guard/.cache && chown -R guard:guard /app /home/guard
USER guard
# 模型下载到卷里的目录，重建容器不用重新下载。
ENV HF_HOME=/home/guard/.cache/huggingface
EXPOSE 8092
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8092"]
