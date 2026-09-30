import io
import sys
import zipfile
from pathlib import Path

import requests


PACKAGES = {
    "punkt_tab": (
        "tokenizers",
        "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/tokenizers/punkt_tab.zip",
    ),
    "averaged_perceptron_tagger_eng": (
        "taggers",
        "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/taggers/averaged_perceptron_tagger_eng.zip",
    ),
}


# 下载并安装 Unstructured 文本分类所需的 NLTK 资源。
def install_packages(target):
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    for name, (category, url) in PACKAGES.items():
        response = requests.get(url, timeout=120)
        response.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            archive.extractall(target / category)
        print(f"installed {name}")


if __name__ == "__main__":
    install_packages(sys.argv[1])
