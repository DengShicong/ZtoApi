/**
 * Z.AI 账号注册管理系统 V2 - 带登录页面和高级配置
 *
 * 功能特性:
 * - 登录鉴权: Session 管理，防止未授权访问
 * - 批量注册: 支持多线程并发注册 Z.AI 账号
 * - 实时监控: SSE 推送实时日志和进度
 * - 账号管理: 查看、搜索、导出注册的账号
 * - 高级配置: 可自定义邮件超时、注册间隔、通知等参数
 *
 * 数据存储: Deno KV (内置键值数据库)
 *
 * @author Your Name
 * @license MIT
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// ==================== 配置区域 ====================

const PORT = 8001;  // Web 服务监听端口
const NOTIFY_INTERVAL = 3600;  // 通知发送间隔（秒）

// 鉴权配置 - 可通过环境变量覆盖
const AUTH_USERNAME = Deno.env.get("ZAI_USERNAME") || "admin";
const AUTH_PASSWORD = Deno.env.get("ZAI_PASSWORD") || "123456";

// 邮箱域名列表 - 用于生成随机临时邮箱
// 这些域名来自 mail.chatgpt.org.uk 的临时邮箱服务
const DOMAINS = [
  "14club.org.uk", "29thnewport.org.uk", "2ndwhartonscoutgroup.org.uk",
  "3littlemiracles.com", "aard.org.uk", "abrahampath.org.uk",
  "aiccministry.com", "allumhall.co.uk", "almiswelfare.org",
  "amyfalconer.co.uk", "avarthanas.org", "aylshamrotary.club",
  "bbfcharity.org", "birdsedgevillagehall.co.uk", "bodyofchristministries.co.uk",
  "bp-hall.co.uk", "brendansbridge.org.uk", "brentwoodmdc.org",
  "cade.org.uk", "caye.org.uk", "cccnoahsark.com", "cccvojc.org",
  "cementingfutures.org", "cephastrust.org", "chatgptuk.pp.ua",
  "christchurchandstgeorges.org", "christchurchsouthend.org.uk",
  "cketrust.org", "club106.org.uk", "cockertonmethodist.org.uk",
  "cok.org.uk", "counsellingit.org", "cumnorthampton.org", "cwetg.co.uk",
  "dormerhouseschool.co.uk", "dpmcharity.org", "e-quiparts.org.uk",
  "eapn-england.org", "educationossett.co.uk", "egremonttrust.org.uk",
  "email.gravityengine.cc", "engagefordevelopment.org", "f4jobseekers.org.uk",
  "flushingvillageclub.org.uk", "fordslane.org.uk", "freemails.pp.ua",
  "friendsofkms.org.uk", "gadshillplace.com", "goleudy.org.uk",
  "gospelassembly.org.uk", "gospelgeneration.org.uk", "gracesanctuary-rccg.co.uk",
  "gravityengine.cc", "greyhoundwalks.org.uk", "gyan-netra.com",
  "haslemerecfr.org.uk", "hfh4elderly.org", "hhe.org.uk",
  "hottchurch.org.uk", "huddsdeafcentre.org", "hvcrc.org",
  "ingrambreamishvalley.co.uk", "iqraacademy.org.uk", "iraniandsa.org"
];

// ==================== 数据存储 ====================

// Deno KV 数据库实例
const kv = await Deno.openKv();

// ==================== 全局状态 ====================

let isRunning = false;  // 注册任务是否正在运行
let shouldStop = false;  // 是否请求停止注册
const sseClients = new Set<ReadableStreamDefaultController>();  // SSE 客户端连接池
let stats = { success: 0, failed: 0, startTime: 0, lastNotifyTime: 0 };  // 统计信息

/**
 * 生成唯一的 Session ID
 */
function generateSessionId(): string {
  return crypto.randomUUID();
}

// 注册配置（可动态调整）
let registerConfig = {
  emailTimeout: 120,  // 邮件等待超时（秒）
  emailCheckInterval: 1,  // 邮件轮询间隔（秒）
  registerDelay: 2000,  // 每个账号注册间隔（毫秒）
  retryTimes: 3,  // API 重试次数
  concurrency: 1,  // 并发数（1-10）
  enableNotification: false,  // 是否启用通知（默认关闭）
  pushplusToken: "",  // PushPlus Token（需要用户自行配置）
};

// ==================== 鉴权相关 ====================

/**
 * 检查请求是否已认证（从 KV 读取 session）
 * @param req HTTP 请求对象
 * @returns 认证状态和 session ID
 */
async function checkAuth(req: Request): Promise<{ authenticated: boolean; sessionId?: string }> {
  const cookies = req.headers.get("Cookie") || "";
  const sessionMatch = cookies.match(/sessionId=([^;]+)/);

  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    // 从 KV 检查 session 是否存在且未过期
    const sessionKey = ["sessions", sessionId];
    const session = await kv.get(sessionKey);

    if (session.value) {
      return { authenticated: true, sessionId };
    }
  }

  return { authenticated: false };
}

// ==================== 工具函数 ====================

/**
 * 生成随机邮箱地址
 * @returns 随机生成的邮箱地址
 */
function createEmail(): string {
  const randomHex = Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
  const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
  return `${randomHex}@${domain}`;
}

/**
 * 生成随机密码
 * @returns 14位随机密码
 */
function createPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from({ length: 14 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}

/**
 * 发送 PushPlus 通知
 * @param title 通知标题
 * @param content 通知内容（支持 Markdown）
 */
async function sendNotification(title: string, content: string): Promise<void> {
  // 检查是否启用通知和 Token 是否配置
  if (!registerConfig.enableNotification || !registerConfig.pushplusToken) return;

  try {
    await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: registerConfig.pushplusToken,
        title,
        content,
        template: "markdown"
      })
    });
  } catch {
    // 忽略错误
  }
}

function broadcast(data: any) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const controller of sseClients) {
    try {
      controller.enqueue(new TextEncoder().encode(message));
    } catch {
      sseClients.delete(controller);
    }
  }
}

/**
 * 获取验证邮件
 * @param email 邮箱地址
 * @returns 邮件内容或 null
 */
async function fetchVerificationEmail(email: string): Promise<string | null> {
  const actualTimeout = registerConfig.emailTimeout;  // 使用配置的超时时间
  const checkInterval = registerConfig.emailCheckInterval;  // 使用配置的轮询间隔
  const startTime = Date.now();
  const apiUrl = `https://mail.chatgpt.org.uk/api/get-emails?email=${encodeURIComponent(email)}`;

  let attempts = 0;
  let lastReportTime = 0;  // 上次报告进度的时间
  const reportInterval = 10;  // 每 10 秒报告一次进度

  while (Date.now() - startTime < actualTimeout * 1000) {
    attempts++;
    try {
      const response = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
      const data = await response.json();

      // 每 10 秒报告一次进度
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed - lastReportTime >= reportInterval && elapsed > 0) {
        broadcast({ type: 'log', level: 'info', message: `  等待验证邮件中... (${elapsed}s/${actualTimeout}s, 已尝试 ${attempts} 次)` });
        lastReportTime = elapsed;
      }

      if (data?.emails) {
        for (const emailData of data.emails) {
          if (emailData.from?.toLowerCase().includes("z.ai")) {
            broadcast({ type: 'log', level: 'success', message: `  ✓ 收到验证邮件 (耗时 ${Math.floor((Date.now() - startTime) / 1000)}s)` });
            return emailData.content || null;
          }
        }
      }
    } catch {
      // 继续重试
    }
    // 使用配置的轮询间隔
    await new Promise(resolve => setTimeout(resolve, checkInterval * 1000));
  }

  broadcast({ type: 'log', level: 'error', message: `  ✗ 验证邮件超时 (等待了 ${actualTimeout}s)` });
  return null;
}

function parseVerificationUrl(url: string): { token: string | null; email: string | null; username: string | null } {
  try {
    const urlObj = new URL(url);
    return {
      token: urlObj.searchParams.get('token'),
      email: urlObj.searchParams.get('email'),
      username: urlObj.searchParams.get('username')
    };
  } catch {
    return { token: null, email: null, username: null };
  }
}

async function saveAccount(email: string, password: string, token: string): Promise<void> {
  const timestamp = Date.now();
  const key = ["zai_accounts", timestamp, email];
  await kv.set(key, {
    email,
    password,
    token,
    createdAt: new Date().toISOString()
  });
}

async function registerAccount(): Promise<boolean> {
  try {
    const email = createEmail();
    const password = createPassword();
    const name = email.split("@")[0];

    broadcast({ type: 'log', level: 'info', message: `▶ 开始注册: ${email}` });

    // 1. 注册
    broadcast({ type: 'log', level: 'info', message: `  → 发送注册请求...` });
    const signupResponse = await fetch("https://chat.z.ai/api/v1/auths/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, profile_image_url: "data:image/png;base64,", sso_redirect: null }),
      signal: AbortSignal.timeout(30000)
    });

    if (signupResponse.status !== 200) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 注册请求失败: HTTP ${signupResponse.status}` });
      stats.failed++;
      return false;
    }

    const signupResult = await signupResponse.json();
    if (!signupResult.success) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 注册被拒绝: ${JSON.stringify(signupResult)}` });
      stats.failed++;
      return false;
    }

    broadcast({ type: 'log', level: 'success', message: `  ✓ 注册请求成功` });

    // 2. 获取验证邮件
    const emailCheckUrl = `https://mail.chatgpt.org.uk/api/get-emails?email=${encodeURIComponent(email)}`;
    broadcast({
      type: 'log',
      level: 'info',
      message: `  → 等待验证邮件...`,
      link: { text: '点击查看邮箱', url: emailCheckUrl }
    });
    const emailContent = await fetchVerificationEmail(email);
    if (!emailContent) {
      stats.failed++;
      return false;
    }

    // 3. 提取验证链接
    broadcast({ type: 'log', level: 'info', message: `  → 提取验证链接...` });

    // 先打印邮件内容用于调试
    broadcast({ type: 'log', level: 'info', message: `  → 邮件内容长度: ${emailContent.length} 字符` });

    // 尝试多种匹配方式
    let verificationUrl = null;

    // 方式1: 匹配 /auth/verify_email 路径（新版本）
    let match = emailContent.match(/https:\/\/chat\.z\.ai\/auth\/verify_email\?[^\s<>"']+/);
    if (match) {
      verificationUrl = match[0].replace(/&amp;/g, '&').replace(/&#39;/g, "'");
      broadcast({ type: 'log', level: 'success', message: `  ✓ 找到验证链接 (新版路径)` });
    }

    // 方式2: 匹配 /verify_email 路径（旧版本）
    if (!verificationUrl) {
      match = emailContent.match(/https:\/\/chat\.z\.ai\/verify_email\?[^\s<>"']+/);
      if (match) {
        verificationUrl = match[0].replace(/&amp;/g, '&').replace(/&#39;/g, "'");
        broadcast({ type: 'log', level: 'success', message: `  ✓ 找到验证链接 (旧版路径)` });
      }
    }

    // 方式3: 匹配HTML编码的URL
    if (!verificationUrl) {
      match = emailContent.match(/https?:\/\/chat\.z\.ai\/(?:auth\/)?verify_email[^"'\s]*/);
      if (match) {
        verificationUrl = match[0].replace(/&amp;/g, '&').replace(/&#39;/g, "'");
        broadcast({ type: 'log', level: 'success', message: `  ✓ 找到验证链接 (HTML解码)` });
      }
    }

    // 方式4: 在JSON中查找
    if (!verificationUrl) {
      try {
        const urlMatch = emailContent.match(/"(https?:\/\/[^"]*verify_email[^"]*)"/);
        if (urlMatch) {
          verificationUrl = urlMatch[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
          broadcast({ type: 'log', level: 'success', message: `  ✓ 找到验证链接 (JSON格式)` });
        }
      } catch (e) {
        // 忽略JSON解析错误
      }
    }

    if (!verificationUrl) {
      // 打印邮件内容的前500个字符用于调试
      const preview = emailContent.substring(0, 500).replace(/\n/g, ' ');
      broadcast({ type: 'log', level: 'error', message: `  ✗ 未找到验证链接，邮件预览: ${preview}...` });
      stats.failed++;
      return false;
    }

    // 打印解析后的URL用于调试
    broadcast({ type: 'log', level: 'info', message: `  → 解析URL: ${verificationUrl}` });

    const { token, email: emailFromUrl, username } = parseVerificationUrl(verificationUrl);
    if (!token || !emailFromUrl || !username) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 验证链接格式错误` });
      stats.failed++;
      return false;
    }

    broadcast({ type: 'log', level: 'success', message: `  ✓ 验证链接已提取` });

    // 4. 完成注册
    broadcast({ type: 'log', level: 'info', message: `  → 提交验证信息...` });
    const finishResponse = await fetch("https://chat.z.ai/api/v1/auths/finish_signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailFromUrl, password, profile_image_url: "data:image/png;base64,", sso_redirect: null, token, username }),
      signal: AbortSignal.timeout(30000)
    });

    if (finishResponse.status !== 200) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 验证失败: HTTP ${finishResponse.status}` });
      stats.failed++;
      return false;
    }

    const finishResult = await finishResponse.json();
    if (!finishResult.success) {
      broadcast({ type: 'log', level: 'error', message: `  ✗ 验证被拒绝: ${JSON.stringify(finishResult)}` });
      stats.failed++;
      return false;
    }

    // 5. 保存
    const userToken = finishResult.user?.token;
    if (userToken) {
      await saveAccount(email, password, userToken);
      stats.success++;
      broadcast({
        type: 'log',
        level: 'success',
        message: `✅ 注册完成: ${email}`,
        stats: { success: stats.success, failed: stats.failed, total: stats.success + stats.failed }
      });
      broadcast({ type: 'account_added', account: { email, password, token: userToken, createdAt: new Date().toISOString() } });
      return true;
    }

    stats.failed++;
    return false;
  } catch (error) {
    broadcast({ type: 'log', level: 'error', message: `  ✗ 异常: ${error.message}` });
    stats.failed++;
    return false;
  }
}

async function batchRegister(count: number): Promise<void> {
  isRunning = true;
  shouldStop = false;
  stats = { success: 0, failed: 0, startTime: Date.now(), lastNotifyTime: Date.now() };

  broadcast({ type: 'start', config: { count } });

  const concurrency = registerConfig.concurrency || 1;
  let completed = 0;

  // 并发注册
  while (completed < count && !shouldStop) {
    // 计算本批次任务数量
    const batchSize = Math.min(concurrency, count - completed);
    const batchPromises: Promise<boolean>[] = [];

    // 创建并发任务
    for (let i = 0; i < batchSize; i++) {
      const taskIndex = completed + i + 1;
      broadcast({ type: 'log', level: 'info', message: `\n[${taskIndex}/${count}] ━━━━━━━━━━━━━━━━━━━━` });
      batchPromises.push(registerAccount());
    }

    // 等待本批次完成
    await Promise.allSettled(batchPromises);
    completed += batchSize;

    // 批次间延迟
    if (completed < count && !shouldStop) {
      await new Promise(resolve => setTimeout(resolve, registerConfig.registerDelay));
    }
  }

  if (shouldStop) {
    broadcast({ type: 'log', level: 'warning', message: `⚠️ 用户手动停止，已完成 ${completed}/${count} 个` });
  }

  const elapsedTime = (Date.now() - stats.startTime) / 1000;

  broadcast({
    type: 'complete',
    stats: { success: stats.success, failed: stats.failed, total: stats.success + stats.failed, elapsedTime: elapsedTime.toFixed(1) }
  });

  // 发送完成通知
  await sendNotification(
    "✅ Z.AI 注册任务完成",
    `## ✅ Z.AI 账号注册任务完成\n\n### 执行结果\n- **成功**: ${stats.success} 个\n- **失败**: ${stats.failed} 个\n- **总计**: ${stats.success + stats.failed} 个\n\n### 耗时统计\n- **总耗时**: ${elapsedTime.toFixed(1)} 秒\n- **平均速度**: ${((stats.success + stats.failed) / (elapsedTime / 60)).toFixed(1)} 个/分钟\n\n### 成功率\n- **成功率**: ${stats.success + stats.failed > 0 ? ((stats.success / (stats.success + stats.failed)) * 100).toFixed(1) : 0}%`
  );

  isRunning = false;
  shouldStop = false;
}

// 登录页面
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - Z.AI 管理系统</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <div class="text-center mb-8">
            <h1 class="text-3xl font-bold text-gray-800 mb-2">🤖 Z.AI 管理系统</h1>
            <p class="text-gray-600">请登录以继续</p>
        </div>

        <form id="loginForm" class="space-y-6">
            <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">用户名</label>
                <input type="text" id="username" required
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">密码</label>
                <input type="password" id="password" required
                    class="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
            </div>

            <div id="errorMsg" class="hidden text-red-500 text-sm text-center"></div>

            <button type="submit"
                class="w-full px-6 py-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all">
                登录
            </button>
        </form>

        <div class="mt-6 text-center text-sm text-gray-500">
            <p>默认账号: admin / 123456</p>
        </div>
    </div>

    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const errorMsg = document.getElementById('errorMsg');

            errorMsg.classList.add('hidden');

            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });

                const result = await response.json();

                if (result.success) {
                    document.cookie = 'sessionId=' + result.sessionId + '; path=/; max-age=86400';
                    window.location.href = '/';
                } else {
                    errorMsg.textContent = result.error || '登录失败';
                    errorMsg.classList.remove('hidden');
                }
            } catch (error) {
                errorMsg.textContent = '网络错误，请重试';
                errorMsg.classList.remove('hidden');
            }
        });
    </script>
</body>
</html>`;

// 主页面
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Z.AI 账号管理系统</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
    <style>
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
        .toast-enter { animation: slideIn 0.3s ease-out; }
        .toast-exit { animation: slideOut 0.3s ease-in; }
    </style>
</head>
<body class="bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 min-h-screen p-4 md:p-8">
    <!-- Toast 容器 -->
    <div id="toastContainer" class="fixed top-4 right-4 z-50 space-y-2"></div>

    <div class="max-w-7xl mx-auto">
        <div class="text-center text-white mb-8">
            <div class="flex items-center justify-between">
                <div class="flex-1"></div>
                <div class="flex-1 text-center">
                    <h1 class="text-4xl md:text-5xl font-bold mb-3">🤖 Z.AI 账号管理系统 V2</h1>
                    <p class="text-lg md:text-xl opacity-90">批量注册 · 数据管理 · 实时监控 · 高级设置</p>
                </div>
                <div class="flex-1 flex justify-end">
                    <button id="logoutBtn" class="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg text-white font-semibold transition">
                        退出登录
                    </button>
                </div>
            </div>
        </div>

        <!-- 控制面板 + 高级设置 -->
        <div class="bg-white rounded-2xl shadow-2xl p-6 mb-6">
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-2xl font-bold text-gray-800">注册控制</h2>
                <div class="flex gap-2">
                    <button id="settingsBtn" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg font-semibold transition">
                        ⚙️ 高级设置
                    </button>
                    <span id="statusBadge" class="px-4 py-2 rounded-full text-sm font-semibold bg-gray-400 text-white">闲置中</span>
                </div>
            </div>

            <!-- 高级设置面板 -->
            <div id="settingsPanel" class="mb-6 p-4 bg-gray-50 rounded-lg hidden">
                <h3 class="font-semibold text-gray-700 mb-4">⚙️ 高级设置</h3>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">邮件等待超时 (秒)</label>
                        <input type="number" id="emailTimeout" value="120" min="30" max="300"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">账号间隔 (毫秒)</label>
                        <input type="number" id="registerDelay" value="2000" min="500" max="10000" step="500"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">邮件轮询间隔（秒）</label>
                        <input type="number" id="emailCheckInterval" value="1" min="0.5" max="10" step="0.5"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                        <p class="text-xs text-gray-500 mt-1">建议：0.5-2秒，过小可能触发限流</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">并发数</label>
                        <input type="number" id="concurrency" value="1" min="1" max="10"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                        <p class="text-xs text-gray-500 mt-1">同时注册的账号数量，建议3-5</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">API 重试次数</label>
                        <input type="number" id="retryTimes" value="3" min="1" max="10"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">PushPlus Token</label>
                        <input type="text" id="pushplusToken" value="" placeholder="留空则不发送通知"
                            class="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    </div>
                    <div class="flex items-center md:col-span-2">
                        <input type="checkbox" id="enableNotification" checked class="w-5 h-5 text-indigo-600 rounded">
                        <label class="ml-3 text-sm font-medium text-gray-700">启用 PushPlus 通知</label>
                    </div>
                </div>
                <div class="mt-4 flex gap-2">
                    <button id="saveSettingsBtn" class="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition">
                        保存设置
                    </button>
                    <button id="cancelSettingsBtn" class="px-6 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition">
                        取消
                    </button>
                </div>
            </div>

            <div class="flex gap-4 mb-4">
                <input type="number" id="registerCount" value="5" min="1" max="100"
                    class="flex-1 px-4 py-3 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                <button id="startRegisterBtn"
                    class="px-8 py-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-60 disabled:cursor-not-allowed">
                    开始注册
                </button>
                <button id="stopRegisterBtn" style="display: none;"
                    class="px-8 py-3 bg-gradient-to-r from-red-500 to-pink-600 text-white font-semibold rounded-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all">
                    停止注册
                </button>
            </div>

            <!-- 进度条 -->
            <div id="progressContainer" style="display: none;" class="mb-4">
                <div class="flex justify-between text-sm text-gray-600 mb-2">
                    <span>注册进度</span>
                    <span id="progressText">0/0 (0%)</span>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
                    <div id="progressBar" class="h-full bg-gradient-to-r from-indigo-500 to-purple-600 rounded-full transition-all duration-300 flex items-center justify-center">
                        <span id="progressPercent" class="text-xs text-white font-semibold"></span>
                    </div>
                </div>
                <div class="flex justify-between text-xs text-gray-500 mt-1">
                    <span id="progressSpeed">速度: 0/分钟</span>
                    <span id="progressETA">预计剩余: --</span>
                </div>
            </div>
        </div>

        <!-- 统计面板 -->
        <div class="bg-white rounded-2xl shadow-2xl p-6 mb-6">
            <h2 class="text-2xl font-bold text-gray-800 mb-4">统计信息</h2>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div class="bg-gradient-to-br from-green-400 to-emerald-500 rounded-xl p-4 text-center text-white">
                    <div class="text-sm opacity-90 mb-1">总账号</div>
                    <div class="text-3xl font-bold" id="totalAccounts">0</div>
                </div>
                <div class="bg-gradient-to-br from-blue-400 to-indigo-500 rounded-xl p-4 text-center text-white">
                    <div class="text-sm opacity-90 mb-1">本次成功</div>
                    <div class="text-3xl font-bold" id="successCount">0</div>
                </div>
                <div class="bg-gradient-to-br from-red-400 to-pink-500 rounded-xl p-4 text-center text-white">
                    <div class="text-sm opacity-90 mb-1">本次失败</div>
                    <div class="text-3xl font-bold" id="failedCount">0</div>
                </div>
                <div class="bg-gradient-to-br from-purple-400 to-fuchsia-500 rounded-xl p-4 text-center text-white">
                    <div class="text-sm opacity-90 mb-1">耗时</div>
                    <div class="text-3xl font-bold" id="timeValue">0s</div>
                </div>
            </div>
        </div>

        <!-- 账号列表 -->
        <div class="bg-white rounded-2xl shadow-2xl p-6 mb-6">
            <div class="flex items-center justify-between mb-4">
                <h2 class="text-2xl font-bold text-gray-800">账号列表</h2>
                <div class="flex gap-2">
                    <input type="text" id="searchInput" placeholder="搜索邮箱..."
                        class="px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-indigo-500 focus:ring focus:ring-indigo-200 transition">
                    <input type="file" id="importFileInput" accept=".txt" style="display: none;">
                    <button id="importBtn"
                        class="px-6 py-2 bg-gradient-to-r from-purple-500 to-violet-600 text-white font-semibold rounded-lg shadow hover:shadow-lg transition">
                        导入 TXT
                    </button>
                    <button id="exportBtn"
                        class="px-6 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-lg shadow hover:shadow-lg transition">
                        导出 TXT
                    </button>
                    <button id="refreshBtn"
                        class="px-6 py-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold rounded-lg shadow hover:shadow-lg transition">
                        刷新
                    </button>
                </div>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full">
                    <thead>
                        <tr class="bg-gray-50 text-left">
                            <th class="px-4 py-3 text-sm font-semibold text-gray-700">序号</th>
                            <th class="px-4 py-3 text-sm font-semibold text-gray-700">邮箱</th>
                            <th class="px-4 py-3 text-sm font-semibold text-gray-700">密码</th>
                            <th class="px-4 py-3 text-sm font-semibold text-gray-700">Token</th>
                            <th class="px-4 py-3 text-sm font-semibold text-gray-700">创建时间</th>
                            <th class="px-4 py-3 text-sm font-semibold text-gray-700">操作</th>
                        </tr>
                    </thead>
                    <tbody id="accountTableBody" class="divide-y divide-gray-200">
                        <tr>
                            <td colspan="6" class="px-4 py-8 text-center text-gray-400">暂无数据</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <!-- 分页控件 -->
            <div class="flex items-center justify-between mt-4 px-4">
                <div class="text-sm text-gray-600">
                    共 <span id="totalItems">0</span> 条数据
                </div>
                <div class="flex items-center gap-2">
                    <button id="firstPageBtn" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">首页</button>
                    <button id="prevPageBtn" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">上一页</button>
                    <div class="flex items-center gap-1" id="pageNumbers"></div>
                    <button id="nextPageBtn" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">下一页</button>
                    <button id="lastPageBtn" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed">尾页</button>
                    <select id="pageSizeSelect" class="ml-2 px-2 py-1 border border-gray-300 rounded">
                        <option value="10">10条/页</option>
                        <option value="20" selected>20条/页</option>
                        <option value="50">50条/页</option>
                        <option value="100">100条/页</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- 实时日志 -->
        <div class="bg-white rounded-2xl shadow-2xl p-6">
            <div class="flex items-center justify-between mb-4">
                <h2 class="text-2xl font-bold text-gray-800">实时日志</h2>
                <button id="clearLogBtn"
                    class="px-4 py-2 bg-gradient-to-r from-gray-500 to-gray-600 text-white font-semibold rounded-lg shadow hover:shadow-lg transition">
                    清空日志
                </button>
            </div>
            <div id="logContainer" class="bg-gray-900 rounded-lg p-4 h-64 overflow-y-auto font-mono text-sm">
                <div class="text-blue-400">等待任务启动...</div>
            </div>
        </div>
    </div>

    <script>
        let accounts = [];
        let filteredAccounts = [];
        let isRunning = false;
        let currentPage = 1;
        let pageSize = 20;
        let taskStartTime = 0;
        let totalTaskCount = 0;

        const $statusBadge = $('#statusBadge');
        const $startRegisterBtn = $('#startRegisterBtn');
        const $stopRegisterBtn = $('#stopRegisterBtn');
        const $logContainer = $('#logContainer');
        const $totalAccounts = $('#totalAccounts');
        const $successCount = $('#successCount');
        const $failedCount = $('#failedCount');
        const $timeValue = $('#timeValue');
        const $accountTableBody = $('#accountTableBody');
        const $searchInput = $('#searchInput');
        const $progressContainer = $('#progressContainer');
        const $progressBar = $('#progressBar');
        const $progressText = $('#progressText');
        const $progressPercent = $('#progressPercent');
        const $progressSpeed = $('#progressSpeed');
        const $progressETA = $('#progressETA');

        // 更新进度条
        function updateProgress(current, total, success, failed) {
            const completed = success + failed;
            const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

            $progressBar.css('width', percent + '%');
            $progressPercent.text(percent + '%');
            $progressText.text(completed + '/' + total + ' (' + percent + '%)');

            // 计算速度和预计剩余时间
            if (taskStartTime > 0 && completed > 0) {
                const elapsed = (Date.now() - taskStartTime) / 1000 / 60; // 分钟
                const speed = completed / elapsed;
                const remaining = total - completed;
                const eta = remaining / speed;

                $progressSpeed.text('速度: ' + speed.toFixed(1) + '/分钟');

                if (eta < 1) {
                    $progressETA.text('预计剩余: <1分钟');
                } else if (eta < 60) {
                    $progressETA.text('预计剩余: ' + Math.ceil(eta) + '分钟');
                } else {
                    const hours = Math.floor(eta / 60);
                    const mins = Math.ceil(eta % 60);
                    $progressETA.text('预计剩余: ' + hours + '小时' + mins + '分钟');
                }
            }
        }

        // Toast 消息提示
        function showToast(message, type = 'info') {
            const colors = {
                success: 'bg-green-500',
                error: 'bg-red-500',
                warning: 'bg-yellow-500',
                info: 'bg-blue-500'
            };
            const icons = {
                success: '✓',
                error: '✗',
                warning: '⚠',
                info: 'ℹ'
            };

            const $toast = $('<div>', {
                class: 'toast-enter ' + colors[type] + ' text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-2 min-w-[300px]',
                html: '<span class="text-xl">' + icons[type] + '</span><span>' + message + '</span>'
            });

            $('#toastContainer').append($toast);

            setTimeout(() => {
                $toast.removeClass('toast-enter').addClass('toast-exit');
                setTimeout(() => $toast.remove(), 300);
            }, 3000);
        }

        function addLog(message, level = 'info', link = null) {
            const colors = { success: 'text-green-400', error: 'text-red-400', warning: 'text-yellow-400', info: 'text-blue-400' };
            const time = new Date().toLocaleTimeString('zh-CN');

            let html = '<span class="text-gray-500">[' + time + ']</span> ' + message;

            // 添加链接
            if (link && link.url) {
                html += ' <a href="' + link.url + '" target="_blank" class="text-cyan-400 hover:text-cyan-300 underline">[' + (link.text || '查看') + ']</a>';
            }

            const $log = $('<div>', {
                class: colors[level] + ' mb-1',
                html: html
            });

            $logContainer.append($log);
            $logContainer[0].scrollTop = $logContainer[0].scrollHeight;
            if ($logContainer.children().length > 200) $logContainer.children().first().remove();
        }

        function updateStatus(running) {
            isRunning = running;
            if (running) {
                $statusBadge.text('运行中').removeClass('bg-gray-400').addClass('bg-green-500');
                $startRegisterBtn.hide();
                $stopRegisterBtn.show();
            } else {
                $statusBadge.text('闲置中').removeClass('bg-green-500').addClass('bg-gray-400');
                $startRegisterBtn.show();
                $stopRegisterBtn.hide();
            }
        }

        function renderTable(data = filteredAccounts) {
            const totalPages = Math.ceil(data.length / pageSize);
            const startIndex = (currentPage - 1) * pageSize;
            const endIndex = startIndex + pageSize;
            const pageData = data.slice(startIndex, endIndex);

            if (pageData.length === 0) {
                $accountTableBody.html('<tr><td colspan="6" class="px-4 py-8 text-center text-gray-400">暂无数据</td></tr>');
            } else {
                const rows = pageData.map((acc, idx) => {
                    const rowId = 'row-' + (startIndex + idx);
                    return '<tr class="hover:bg-gray-50" id="' + rowId + '">' +
                        '<td class="px-4 py-3 text-sm text-gray-700">' + (startIndex + idx + 1) + '</td>' +
                        '<td class="px-4 py-3 text-sm text-gray-700">' + acc.email + '</td>' +
                        '<td class="px-4 py-3 text-sm text-gray-700"><code class="bg-gray-100 px-2 py-1 rounded">' + acc.password + '</code></td>' +
                        '<td class="px-4 py-3 text-sm text-gray-700"><code class="bg-gray-100 px-2 py-1 rounded text-xs">' + acc.token.substring(0, 20) + '...</code></td>' +
                        '<td class="px-4 py-3 text-sm text-gray-700">' + new Date(acc.createdAt).toLocaleString('zh-CN') + '</td>' +
                        '<td class="px-4 py-3 flex gap-2">' +
                            '<button class="copy-account-btn text-blue-600 hover:text-blue-800 text-sm font-medium" data-email="' + acc.email + '" data-password="' + acc.password + '">复制账号</button>' +
                            '<button class="copy-token-btn text-green-600 hover:text-green-800 text-sm font-medium" data-token="' + acc.token + '">复制Token</button>' +
                        '</td>' +
                    '</tr>';
                });
                $accountTableBody.html(rows.join(''));

                // 绑定事件
                $('.copy-account-btn').on('click', function() {
                    const email = $(this).data('email');
                    const password = $(this).data('password');
                    navigator.clipboard.writeText(email + '----' + password);
                    showToast('已复制账号: ' + email, 'success');
                });

                $('.copy-token-btn').on('click', function() {
                    const token = $(this).data('token');
                    navigator.clipboard.writeText(token);
                    showToast('已复制 Token', 'success');
                });
            }

            // 更新分页控件
            updatePagination(data.length, totalPages);
        }

        function updatePagination(totalItems, totalPages) {
            $('#totalItems').text(totalItems);

            // 更新按钮状态
            $('#firstPageBtn, #prevPageBtn').prop('disabled', currentPage === 1);
            $('#nextPageBtn, #lastPageBtn').prop('disabled', currentPage === totalPages || totalPages === 0);

            // 渲染页码
            const $pageNumbers = $('#pageNumbers');
            $pageNumbers.empty();

            if (totalPages <= 7) {
                for (let i = 1; i <= totalPages; i++) {
                    addPageButton(i, $pageNumbers);
                }
            } else {
                addPageButton(1, $pageNumbers);
                if (currentPage > 3) $pageNumbers.append('<span class="px-2">...</span>');

                let start = Math.max(2, currentPage - 1);
                let end = Math.min(totalPages - 1, currentPage + 1);

                for (let i = start; i <= end; i++) {
                    addPageButton(i, $pageNumbers);
                }

                if (currentPage < totalPages - 2) $pageNumbers.append('<span class="px-2">...</span>');
                addPageButton(totalPages, $pageNumbers);
            }
        }

        function addPageButton(page, container) {
            const isActive = page === currentPage;
            const $btn = $('<button>', {
                text: page,
                class: 'px-3 py-1 border rounded ' + (isActive ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 hover:bg-gray-100'),
                click: () => {
                    currentPage = page;
                    renderTable();
                }
            });
            container.append($btn);
        }

        async function loadAccounts() {
            const response = await fetch('/api/accounts');
            accounts = await response.json();
            filteredAccounts = accounts;
            $totalAccounts.text(accounts.length);
            currentPage = 1;
            renderTable();
        }

        $searchInput.on('input', function() {
            const keyword = $(this).val().toLowerCase();
            filteredAccounts = accounts.filter(acc => acc.email.toLowerCase().includes(keyword));
            currentPage = 1;
            renderTable();
        });

        // 分页按钮事件
        $('#firstPageBtn').on('click', () => { currentPage = 1; renderTable(); });
        $('#prevPageBtn').on('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
        $('#nextPageBtn').on('click', () => { const totalPages = Math.ceil(filteredAccounts.length / pageSize); if (currentPage < totalPages) { currentPage++; renderTable(); } });
        $('#lastPageBtn').on('click', () => { currentPage = Math.ceil(filteredAccounts.length / pageSize); renderTable(); });
        $('#pageSizeSelect').on('change', function() {
            pageSize = parseInt($(this).val());
            currentPage = 1;
            renderTable();
        });

        async function loadSettings() {
            try {
                const response = await fetch('/api/config');
                if (!response.ok) {
                    if (response.status === 302) {
                        window.location.href = '/login';
                        return;
                    }
                    throw new Error('HTTP ' + response.status);
                }
                const config = await response.json();
                $('#emailTimeout').val(config.emailTimeout);
                $('#emailCheckInterval').val(config.emailCheckInterval || 1);
                $('#registerDelay').val(config.registerDelay);
                $('#retryTimes').val(config.retryTimes);
                $('#concurrency').val(config.concurrency || 1);
                $('#enableNotification').prop('checked', config.enableNotification);
                $('#pushplusToken').val(config.pushplusToken || '');
            } catch (error) {
                console.error('加载配置失败:', error);
                showToast('加载配置失败', 'error');
            }
        }

        $('#refreshBtn').on('click', loadAccounts);

        $('#clearLogBtn').on('click', function() {
            $logContainer.html('<div class="text-gray-500">日志已清空</div>');
            addLog('✓ 日志已清空', 'success');
        });

        $('#settingsBtn').on('click', function() {
            $('#settingsPanel').slideToggle();
        });

        $('#cancelSettingsBtn').on('click', function() {
            $('#settingsPanel').slideUp();
        });

        $('#saveSettingsBtn').on('click', async function() {
            try {
                const config = {
                    emailTimeout: parseInt($('#emailTimeout').val()),
                    emailCheckInterval: parseFloat($('#emailCheckInterval').val()),
                    registerDelay: parseInt($('#registerDelay').val()),
                    retryTimes: parseInt($('#retryTimes').val()),
                    concurrency: parseInt($('#concurrency').val()),
                    enableNotification: $('#enableNotification').is(':checked'),
                    pushplusToken: $('#pushplusToken').val().trim()
                };

                const response = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });

                if (!response.ok) {
                    if (response.status === 302) {
                        window.location.href = '/login';
                        return;
                    }
                    throw new Error('HTTP ' + response.status);
                }

                const result = await response.json();
                if (result.success) {
                    showToast('设置已保存', 'success');
                    $('#settingsPanel').slideUp();
                } else {
                    showToast('保存失败: ' + (result.error || '未知错误'), 'error');
                }
            } catch (error) {
                console.error('保存配置失败:', error);
                showToast('保存失败: ' + error.message, 'error');
            }
        });

        $('#logoutBtn').on('click', async function() {
            if (confirm('确定要退出登录吗？')) {
                await fetch('/api/logout', { method: 'POST' });
                document.cookie = 'sessionId=; path=/; max-age=0';
                window.location.href = '/login';
            }
        });

        $('#exportBtn').on('click', async function() {
            try {
                const response = await fetch('/api/export');
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'zai_accounts_' + Date.now() + '.txt';
                a.click();
                showToast('导出成功！', 'success');
            } catch (error) {
                showToast('导出失败: ' + error.message, 'error');
            }
        });

        $('#importBtn').on('click', function() {
            $('#importFileInput').click();
        });

        $('#importFileInput').on('change', async function(e) {
            const file = e.target.files[0];
            if (!file) return;

            try {
                showToast('开始导入，请稍候...', 'info');
                const text = await file.text();
                const lines = text.split('\\n').filter(line => line.trim());

                // 准备批量数据
                const importData = [];
                const emailSet = new Set();

                for (const line of lines) {
                    const parts = line.split('----');
                    let email, password, token;

                    if (parts.length >= 4) {
                        email = parts[0].trim();
                        password = parts[1].trim();
                        token = parts[2].trim() + '----' + parts[3].trim();
                    } else if (parts.length === 3) {
                        email = parts[0].trim();
                        password = parts[1].trim();
                        token = parts[2].trim();
                    } else {
                        continue;
                    }

                    // 去重检查
                    if (!emailSet.has(email)) {
                        emailSet.add(email);
                        importData.push({ email, password, token });
                    }
                }

                // 批量导入
                const response = await fetch('/api/import-batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accounts: importData })
                });

                const result = await response.json();
                if (result.success) {
                    showToast('导入完成！成功: ' + result.imported + ', 跳过重复: ' + result.skipped, 'success');
                    await loadAccounts();
                } else {
                    showToast('导入失败: ' + result.error, 'error');
                }

                $(this).val('');
            } catch (error) {
                showToast('导入失败: ' + error.message, 'error');
            }
        });

        $startRegisterBtn.on('click', async function() {
            try {
                const count = parseInt($('#registerCount').val());
                if (!count || count < 1) {
                    alert('请输入有效数量');
                    return;
                }

                const response = await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ count })
                });

                if (!response.ok) {
                    if (response.status === 302) {
                        window.location.href = '/login';
                        return;
                    }
                    throw new Error('HTTP ' + response.status);
                }

                const result = await response.json();
                if (!result.success) {
                    addLog('✗ ' + (result.error || '启动失败'), 'error');
                }
            } catch (error) {
                console.error('启动注册失败:', error);
                addLog('✗ 启动失败: ' + error.message, 'error');
            }
        });

        $stopRegisterBtn.on('click', async function() {
            if (confirm('确定要停止当前注册任务吗？')) {
                const response = await fetch('/api/stop', { method: 'POST' });
                const result = await response.json();
                if (result.success) {
                    addLog('⚠️ 已发送停止信号...', 'warning');
                }
            }
        });

        function connectSSE() {
            const eventSource = new EventSource('/events');
            eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                switch (data.type) {
                    case 'connected':
                        addLog('✓ 已连接到服务器', 'success');
                        updateStatus(data.isRunning);
                        break;
                    case 'start':
                        updateStatus(true);
                        taskStartTime = Date.now();
                        totalTaskCount = data.config.count;
                        $progressContainer.show();
                        updateProgress(0, totalTaskCount, 0, 0);
                        addLog('🚀 开始注册 ' + data.config.count + ' 个账号', 'info');
                        $successCount.text(0);
                        $failedCount.text(0);
                        break;
                    case 'log':
                        addLog(data.message, data.level, data.link);
                        if (data.stats) {
                            $successCount.text(data.stats.success);
                            $failedCount.text(data.stats.failed);
                            updateProgress(data.stats.total, totalTaskCount, data.stats.success, data.stats.failed);
                        }
                        break;
                    case 'account_added':
                        accounts.unshift(data.account);
                        filteredAccounts = accounts;
                        $totalAccounts.text(accounts.length);
                        renderTable();
                        break;
                    case 'complete':
                        updateStatus(false);
                        $successCount.text(data.stats.success);
                        $failedCount.text(data.stats.failed);
                        $timeValue.text(data.stats.elapsedTime + 's');
                        updateProgress(data.stats.total, totalTaskCount, data.stats.success, data.stats.failed);
                        addLog('✓ 注册完成！成功: ' + data.stats.success + ', 失败: ' + data.stats.failed, 'success');
                        setTimeout(() => $progressContainer.fadeOut(), 3000);
                        break;
                }
            };
            eventSource.onerror = () => {
                addLog('✗ 连接断开，5秒后重连...', 'error');
                eventSource.close();
                setTimeout(connectSSE, 5000);
            };
        }

        $(document).ready(function() {
            loadAccounts();
            loadSettings();
            connectSSE();
        });
    </script>
</body>
</html>`;

// HTTP 处理器
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // 登录页面（无需鉴权）
  if (url.pathname === "/login") {
    return new Response(LOGIN_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // 登录 API（无需鉴权）
  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await req.json();
    if (body.username === AUTH_USERNAME && body.password === AUTH_PASSWORD) {
      const sessionId = generateSessionId();

      // 保存 session 到 KV，设置 24 小时过期
      const sessionKey = ["sessions", sessionId];
      await kv.set(sessionKey, { createdAt: Date.now() }, { expireIn: 86400000 }); // 24小时过期

      return new Response(JSON.stringify({ success: true, sessionId }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ success: false, error: "用户名或密码错误" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 鉴权检查（其他所有路径都需要验证）
  const auth = await checkAuth(req);
  if (!auth.authenticated) {
    return new Response(null, {
      status: 302,
      headers: { "Location": "/login" }
    });
  }

  // 登出 API
  if (url.pathname === "/api/logout" && req.method === "POST") {
    if (auth.sessionId) {
      // 从 KV 删除 session
      const sessionKey = ["sessions", auth.sessionId];
      await kv.delete(sessionKey);
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 主页
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(HTML_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // 获取配置
  if (url.pathname === "/api/config" && req.method === "GET") {
    // 从 KV 读取配置，如果不存在则返回默认值
    const configKey = ["config", "register"];
    const savedConfig = await kv.get(configKey);

    const config = savedConfig.value || registerConfig;
    return new Response(JSON.stringify(config), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 保存配置
  if (url.pathname === "/api/config" && req.method === "POST") {
    const body = await req.json();
    registerConfig = { ...registerConfig, ...body };

    // 保存到 KV 持久化
    const configKey = ["config", "register"];
    await kv.set(configKey, registerConfig);

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // SSE
  if (url.pathname === "/events") {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        const message = `data: ${JSON.stringify({ type: 'connected', isRunning })}\n\n`;
        controller.enqueue(new TextEncoder().encode(message));
        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepAlive);
            sseClients.delete(controller);
          }
        }, 30000);
      }
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }
    });
  }

  // 账号列表
  if (url.pathname === "/api/accounts") {
    const accounts = [];
    const entries = kv.list({ prefix: ["zai_accounts"] }, { reverse: true });
    for await (const entry of entries) {
      accounts.push(entry.value);
    }
    return new Response(JSON.stringify(accounts), { headers: { "Content-Type": "application/json" } });
  }

  // 导出
  if (url.pathname === "/api/export") {
    const lines: string[] = [];
    const entries = kv.list({ prefix: ["zai_accounts"] });
    for await (const entry of entries) {
      const data = entry.value as any;
      lines.push(`${data.email}----${data.password}----${data.token}`);
    }
    return new Response(lines.join('\n'), {
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": `attachment; filename="zai_accounts_${Date.now()}.txt"`
      }
    });
  }

  // 导入
  if (url.pathname === "/api/import" && req.method === "POST") {
    try {
      const body = await req.json();
      const { email, password, token } = body;

      if (!email || !password || !token) {
        return new Response(JSON.stringify({ success: false, error: "缺少必要字段" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 保存到 KV
      const timestamp = Date.now();
      const key = ["zai_accounts", timestamp, email];
      await kv.set(key, {
        email,
        password,
        token,
        createdAt: new Date().toISOString()
      });

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // 批量导入（优化性能，支持去重）
  if (url.pathname === "/api/import-batch" && req.method === "POST") {
    try {
      const body = await req.json();
      const { accounts: importAccounts } = body;

      if (!Array.isArray(importAccounts)) {
        return new Response(JSON.stringify({ success: false, error: "数据格式错误" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 获取已存在的邮箱
      const existingEmails = new Set();
      const entries = kv.list({ prefix: ["zai_accounts"] });
      for await (const entry of entries) {
        const data = entry.value as any;
        existingEmails.add(data.email);
      }

      // 批量写入（去重）
      let imported = 0;
      let skipped = 0;
      const timestamp = Date.now();

      for (const [index, acc] of importAccounts.entries()) {
        const { email, password, token } = acc;

        if (!email || !password || !token) {
          skipped++;
          continue;
        }

        // 检查是否已存在
        if (existingEmails.has(email)) {
          skipped++;
          continue;
        }

        // 使用不同的时间戳避免键冲突
        const key = ["zai_accounts", timestamp + index, email];
        await kv.set(key, {
          email,
          password,
          token,
          createdAt: new Date().toISOString()
        });

        existingEmails.add(email);
        imported++;
      }

      return new Response(JSON.stringify({ success: true, imported, skipped }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // 开始注册
  if (url.pathname === "/api/register" && req.method === "POST") {
    if (isRunning) {
      return new Response(JSON.stringify({ error: "任务正在运行中" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const body = await req.json();
    const count = body.count || 5;
    batchRegister(count);
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  // 停止注册
  if (url.pathname === "/api/stop" && req.method === "POST") {
    if (!isRunning) {
      return new Response(JSON.stringify({ error: "没有运行中的任务" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    shouldStop = true;
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  return new Response("Not Found", { status: 404 });
}

// 启动时从 KV 加载配置
(async () => {
  const configKey = ["config", "register"];
  const savedConfig = await kv.get(configKey);
  if (savedConfig.value) {
    registerConfig = { ...registerConfig, ...savedConfig.value };
    console.log("✓ 已加载保存的配置");
  }
})();

console.log(`🚀 Z.AI 管理系统 V2 启动: http://localhost:${PORT}`);
console.log(`🔐 登录账号: ${AUTH_USERNAME}`);
console.log(`🔑 登录密码: ${AUTH_PASSWORD}`);
console.log(`💡 访问 http://localhost:${PORT}/login 登录`);
await serve(handler, { port: PORT });
