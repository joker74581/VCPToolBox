#!/usr/bin/env bash
set -euo pipefail

echo "============================================="
echo "   VCPToolBox - Safe Upstream Update         "
echo "============================================="

cd "$(dirname "$0")"
echo "当前工作目录: $(pwd)"

UPSTREAM_URL="${VCP_UPSTREAM_URL:-https://github.com/lioensky/VCPToolBox.git}"
FORK_URL="${VCP_FORK_URL:-https://github.com/joker74581/VCPToolBox.git}"
BRANCH="${VCP_BRANCH:-main}"

fail() {
    echo ""
    echo "[停止] $1"
    exit 1
}

require_clean_git_state() {
    if git diff --name-only --diff-filter=U | grep -q .; then
        echo "[Git] 检测到尚未解决的冲突文件："
        git diff --name-only --diff-filter=U
        fail "请先解决冲突并提交，再运行更新脚本。"
    fi

    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "[Git] 检测到 tracked 文件存在本地改动。"
        echo "[Git] 为了保护你的插件和配置，本脚本不会自动 stash/pull。"
        echo ""
        echo "建议先执行："
        echo "  git status --short"
        echo "  git add <你确认要保留的源码文件>"
        echo "  git commit -m \"保存本地修改\""
        echo ""
        fail "工作区不干净。"
    fi
}

ensure_remote() {
    local name="$1"
    local url="$2"

    if git remote get-url "$name" >/dev/null 2>&1; then
        git remote set-url "$name" "$url"
    else
        git remote add "$name" "$url"
    fi
}

echo "[Git] 配置远程仓库..."
ensure_remote origin "$FORK_URL"
ensure_remote upstream "$UPSTREAM_URL"
git remote set-url --push upstream DISABLED 2>/dev/null || true
git config core.filemode false

echo "[Git] 当前远程："
git remote -v
echo ""

require_clean_git_state

echo "[Git] 拉取作者仓库最新代码..."
git fetch --prune upstream "$BRANCH"

LOCAL_HEAD="$(git rev-parse HEAD)"
UPSTREAM_HEAD="$(git rev-parse "upstream/$BRANCH")"

if [ "$LOCAL_HEAD" = "$UPSTREAM_HEAD" ]; then
    echo "[Git] 当前已经是作者最新版本。"
else
    echo "[Git] 准备合并 upstream/$BRANCH。"
    if git merge --ff-only "upstream/$BRANCH"; then
        echo "[Git] 已快进到作者最新版本。"
    else
        echo "[Git] 当前分支包含本地提交，不能快进合并。"
        echo "可选处理方式："
        echo "  git rebase upstream/$BRANCH   # 推荐：把你的提交挪到作者新代码之后"
        echo "  git merge upstream/$BRANCH    # 备选：保留一个合并提交"
        fail "需要人工选择 rebase 或 merge。"
    fi
fi

if [ -f "requirements.txt" ]; then
    if [ ! -d "venv" ]; then
        echo "[Python] 未检测到 venv，正在创建虚拟环境..."
        python3 -m venv venv
    fi
    echo "[Python] 更新主系统 Python 依赖..."
    grep -v "win10toast" requirements.txt > requirements_linux.txt
    ./venv/bin/python -m pip install --upgrade pip
    ./venv/bin/pip install -r requirements_linux.txt
    rm -f requirements_linux.txt
else
    echo "[Python] 未检测到 requirements.txt，跳过。"
fi

echo "[Node.js] 更新 Node.js 依赖..."
npm install

if [ -d "rust-vexus-lite" ] && command -v cargo >/dev/null 2>&1; then
    echo "[Rust] 编译向量引擎..."
    (cd rust-vexus-lite && npm run build)
else
    echo "[Rust] 未检测到 cargo 或 rust-vexus-lite，跳过。"
fi

echo "============================================="
echo "[Success] 更新完成。"
echo "============================================="
