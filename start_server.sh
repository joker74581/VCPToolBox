#!/bin/bash

# 获取当前脚本所在目录并进入
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"



# ---------------------------------------------------------
# 尝试加载 Node.js 环境 (应对宝塔/Cron 等非交互式环境找不到 pm2 的问题)
# ---------------------------------------------------------
# 强制获取并导出当前执行用户的真实 HOME 目录（应对宝塔计划任务中 HOME 变量丢失的问题）
USER_HOME=$(getent passwd $(whoami) | cut -d: -f6)
export HOME="$USER_HOME"

# 1. 补充常见的全局 Node 路径兜底（涵盖各种系统级安装），放到 PATH 最末尾，优先级最低
export PATH="$PATH:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/www/server/nodejs/v24.14.1/bin"

# 2. 动态尝试加载当前用户的 NVM (Node Version Manager)
# 放在后面执行，是因为 nvm 会把自己的路径强行插到 PATH 的最前面，确保 NVM 拥有最高优先级！
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# 激活 Python 虚拟环境（供 PM2 子进程继承）
export VIRTUAL_ENV="$APP_DIR/venv"
export PATH="$VIRTUAL_ENV/bin:$PATH"

# 扩大 Node.js libuv 线程池大小（防止大量 I/O 和 Rust 向量库造成的线程饥饿）
export UV_THREADPOOL_SIZE=64

MAIN_PORT="$(grep -E '^PORT=' "$APP_DIR/config.env" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]')"
MAIN_PORT="${MAIN_PORT:-8088}"
ADMIN_PORT=$((MAIN_PORT + 1))
PM2_MAIN_NAME="vcp-main"
PM2_ADMIN_NAME="vcp-admin"

echo "============================================"
echo "   VCPToolBox - Starting Services via PM2 (Linux)"
echo "============================================"
echo ""
echo "Working directory: $(pwd)"
echo "Main port: ${MAIN_PORT}"
echo "Admin port: ${ADMIN_PORT}"
echo "PM2 main process: ${PM2_MAIN_NAME}"
echo "PM2 admin process: ${PM2_ADMIN_NAME}"
echo ""

# 0. 检查并编译 AdminPanel-Vue 前端
if [ ! -f "AdminPanel-Vue/dist/index.html" ]; then
    echo "[Build] 未找到 AdminPanel-Vue 前端编译文件，准备开始编译..."
    if [ -f "AdminPanel-Vue/package.json" ]; then
        cd AdminPanel-Vue
        npm install
        npm run build
        cd ..
        if [ -f "AdminPanel-Vue/dist/index.html" ]; then
            echo "[Build] AdminPanel-Vue 编译成功！"
        else
            echo "[Build] WARNING: AdminPanel-Vue 编译可能失败，管理面板可能无法正常工作。"
        fi
    else
        echo "[Build] WARNING: 未找到 AdminPanel-Vue/package.json，跳过编译。"
    fi
else
    echo "[Build] 发现已编译好的 AdminPanel-Vue 前端文件，跳过编译。"
fi
echo ""

# 1. 清理旧进程确保干净启动
echo "[Cleanup] 正在清理旧的 PM2 进程..."
pm2 delete "${PM2_MAIN_NAME}" 2>/dev/null || true
pm2 delete "${PM2_ADMIN_NAME}" 2>/dev/null || true
pm2 delete vcp-main-7088 2>/dev/null || true
pm2 delete vcp-admin-7089 2>/dev/null || true
pm2 delete "vcp-main-${MAIN_PORT}" 2>/dev/null || true
pm2 delete "vcp-admin-${ADMIN_PORT}" 2>/dev/null || true
echo ""

# 2. 启动主服务进程
echo "[1/2] 正在启动主聊天服务 (${PM2_MAIN_NAME})..."
# --kill-timeout 15000: 给主程序 15 秒的时间来安全保存向量数据库索引
pm2 start server.js --name "${PM2_MAIN_NAME}" --cwd "$APP_DIR" --max-memory-restart 4096M --kill-timeout 15000

echo ""
echo "等待 8 秒钟以让主服务完成知识库和向量模块的初始化..."
sleep 8

# 3. 启动管理面板进程
echo "[2/2] 正在启动管理面板 (${PM2_ADMIN_NAME})..."
pm2 start adminServer.js --name "${PM2_ADMIN_NAME}" --cwd "$APP_DIR" --max-memory-restart 512M --kill-timeout 5000

echo ""
echo "============================================"
echo "   所有服务已启动完毕！"
echo "============================================"
echo ""
pm2 list
