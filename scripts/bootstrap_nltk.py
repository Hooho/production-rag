import io
import os
import sys
import time
import zipfile
from pathlib import Path

import requests


# 下载地址的前缀可以用环境变量 NLTK_DATA_BASE_URL 换成镜像（构建镜像时 GitHub 访问不了的情况）。
BASE_URL = os.environ.get("NLTK_DATA_BASE_URL") or "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages"
PACKAGES = {
    "punkt_tab": ("tokenizers", "tokenizers/punkt_tab.zip"),
    "averaged_perceptron_tagger_eng": ("taggers", "taggers/averaged_perceptron_tagger_eng.zip"),
}
ATTEMPTS = 5


# 下载一个文件；网络抖动（连接被断开、超时）时等几秒重试，最多 ATTEMPTS 次。
def download(url):
    for attempt in range(1, ATTEMPTS + 1):
        try:
            response = requests.get(url, timeout=120)
            response.raise_for_status()
            return response.content
        except requests.RequestException as error:
            if attempt == ATTEMPTS:
                raise SystemExit(f"下载 {url} 失败（已重试 {ATTEMPTS} 次）：{error}\n"
                    "GitHub 访问不了时，在 .env 里填 HTTP_PROXY / HTTPS_PROXY，或设置构建参数 NLTK_DATA_BASE_URL 换成镜像地址。")
            print(f"下载失败，{attempt * 3} 秒后重试（第 {attempt} 次）：{error}", flush=True)
            time.sleep(attempt * 3)


# 下载并安装 Unstructured 文本分类所需的 NLTK 资源。
def install_packages(target):
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    for name, (category, path) in PACKAGES.items():
        content = download(f"{BASE_URL.rstrip('/')}/{path}")
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            archive.extractall(target / category)
        print(f"installed {name}")


if __name__ == "__main__":
    install_packages(sys.argv[1])
