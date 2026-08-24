# 造神计划 · 云端版 — Render 部署手册

> 目标：把 `zs5-cloud/` 部署到 Render Web Service（Node.js），获得固定公网专属链接，手机 / 电脑多端数据实时同步。
> 本手册假设你已在本地拥有完整项目（`server.js` + `public/index.html` 等），只差上传与部署。

---

## 一、项目结构（部署仓库）

```
zs5-cloud/
├── server.js          # 零依赖 Node 后端（workspace REST / 上传 / 迁移 / 静态托管）
├── package.json       # Node 项目描述 + 启动命令 node server.js
├── .gitignore         # 排除 data/ 与 node_modules（隐私 + 运行期自动生成）
├── README.md          # 本手册
└── public/
    └── index.html      # 前端（CLOUD 适配器，含 ws 令牌自动生成逻辑）
```

> ⚠️ `data/` 目录**运行时自动生成**，不入库：
> - 里面是你的个人健身数据（`data/ws/<token>.json`）和上传的图片（`data/uploads/<token>/`）。
> - 已写入 `.gitignore`，切勿把 `data/` 推到公开 GitHub 仓库。

---

## 二、本地预览（可选，先确认能跑）

```bash
cd zs5-cloud
node server.js
# 终端出现 [zs5-cloud] listening on http://localhost:3000
# 浏览器打开 http://localhost:3000 ，首次访问自动跳转为 .../?ws=令牌
```

只要本地能跑，部署到 Render 就不会有代码层面的问题（Render 只是把同样的环境放到公网）。

---

## 三、Git 初始化与推送到 GitHub

在 **zs5-cloud 目录**下依次执行（复制即可用）：

```bash
# 1. 进入项目目录
cd zs5-cloud

# 2. 初始化仓库
git init

# 3. 添加全部文件（data/ 已被 .gitignore 排除）
git add .

# 4. 提交
git commit -m "feat: 造神计划云端版 - Render 部署"

# 5. 关联远程仓库（把 <你的用户名> 和 <仓库名> 换成你自己的）
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git

# 6. 推送到 GitHub
git push -u origin main
```

> 如果远程仓库已经存在且你先 `git clone` 下来了，跳过 `git init` / `git remote add`，直接 `git add . && git commit && git push` 即可。
> 推送前用 `git status` 确认没有出现 `data/` 被加入；若出现，执行 `git rm -r --cached data/` 后再提交。

---

## 四、Render 部署步骤（图文式）

1. **注册 / 登录** Render
   打开 https://dashboard.render.com/ ，用 GitHub 账号登录（会请求授权，允许它读取你的仓库）。

2. **新建 Web Service**
   右上角 **New +** → 选 **Web Service**。

3. **连接仓库**
   在 "Connect a repository" 里选中你刚推送的 `zs5-cloud` 仓库（如未列出，点 **Configure account** 授权 GitHub 权限后刷新）。

4. **基础配置**（关键项）
   | 字段 | 填法 |
   |------|------|
   | Name | 任意，如 `zs5-cloud`（会组成 `zs5-cloud.onrender.com`） |
   | Region | 选离你近的，如 `Singapore`（新加坡） |
   | Branch | `main` |
   | Runtime | **Node** |
   | Build Command | **留空**（零依赖，无需 npm install） |
   | Start Command | `node server.js` |

5. **实例类型**
   选 **Free**（免费层即可，个人使用足够）。

6. **环境变量（可选）**
   默认无需设置：Render 会自动注入 `PORT`，服务端监听该端口，`DATA_DIR` 默认用 `./data`（运行期自动创建）。
   如需自定义数据目录（例如挂载 Render Disk 后指向磁盘挂载点），在 **Advanced → Environment** 加：
   - `DATA_DIR` = `/data`（仅当你在下面第 7 步挂了磁盘才需要）

7. **创建服务**
   拉到底点 **Create Web Service**。
   Render 开始拉取代码 → 构建（空）→ 启动 `node server.js`。
   在 **Logs** 里看到 `[zs5-cloud] listening on http://localhost:<PORT>` 即成功。

8. **拿到公网链接**
   部署完成后，Render 分配一个固定地址：`https://<你的服务名>.onrender.com`
   这就是你的**专属公网链接**，发给手机、电脑都能开。

---

## 五、部署成功后的验证 + 手机访问

### 5.1 健康检查（最快确认存活）
浏览器打开：`https://<你的服务名>.onrender.com/api/health`
返回 `{"ok":true,"t":...}` 即说明后端在线。

### 5.2 首次访问自动生成令牌
打开 `https://<你的服务名>.onrender.com`，页面会自动跳转为：
`https://<你的服务名>.onrender.com/?ws=<随机令牌>`
URL 里的 `?ws=` 就是你的数据钥匙，**保存好这个带参数的完整链接**。

### 5.3 多端实时同步验证
1. 电脑端：在「今日任务」记一条体重（或任意数据）。
2. 手机端：用**同一个带 `?ws=` 的链接**打开，下拉/稍等几秒自动拉取，应能立刻看到电脑端刚记的数据。
3. 反向再测一次：手机端录入 → 电脑端刷新可见，确认双向同步。

> 同步机制：每次操作本地写入后防抖 500ms 上报云端；前端每 30s 自动拉取一次；断网时本地镜像兜底，恢复后批量上报。所以偶尔有几秒延迟属正常。

### 5.4 历史数据迁移（旧版 → 云端）
打开任意端的「使用指南」模块，找到 **一键迁移本机旧数据** 按钮：
- 它会读取浏览器里旧版 `造神计划.html` 的 `zs5_*` / `zaoshen_*` 数据，通过 `/api/migrate` 导入当前云端 workspace。
- 迁移后旧版数据仍保留在浏览器本地，**互不干扰**。

### 5.5 备份与恢复
- 指南页可 **下载云端备份**（生成 `ZS5.<base64>` 文本）。
- 换设备或误删时，用「合并导入 / 覆盖导入」把备份文本贴回即可。

---

## 六、重要注意事项（必读）

1. **Render 免费层文件系统是临时的**：每次重新部署（redeploy）会重置容器，`data/` 下的数据会清空。
   - 个人低频使用（不常 redeploy）基本无感。
   - 如需真正持久化：在 Render 上挂一个 **Render Disk**（付费），挂载路径设为 `/data`，并把环境变量 `DATA_DIR` 设为 `/data`。
2. **冷启动慢**：免费层闲置 15 分钟后会休眠，首次打开需 ~30 秒唤醒，属正常。
3. **链接即凭证**：`?ws=` 令牌就是你的数据钥匙，任何人拿到完整链接都能读写你的数据。**不要公开分享**。
4. **离线备份不变**：旧版 `Documents\我的健身系统\个人训练系统\造神计划.html` 作为纯本地离线版本保留，**未做任何改动**，断网时仍可单机使用。

---

## 七、ws 令牌生成逻辑（代码片段说明）

首次访问由前端 `cloudInit()` 自动完成，无需任何手动操作：

```js
// 从 URL 读取 ?ws= 令牌（兼容 hash 形式）
function _tokenFromURL(){
  var u=new URL(location.href);
  var w=u.searchParams.get('ws');
  if(w) return w;
  var h=u.hash.match(/ws=([^&]+)/);
  return h?h[1]:null;
}
// 把令牌写回 URL（不刷新页面）
function _setURLToken(t){
  var u=new URL(location.href);
  u.searchParams.set('ws',t);
  history.replaceState(null,'',u.pathname+u.search+u.hash);
}
// 调后端新建 workspace，拿到令牌
function _createWS(){
  return fetch('/api/workspace/new').then(r=>r.json()).then(res=>res.token);
}
// 初始化：无令牌则自动创建并拼接 ?ws=
function cloudInit(done){
  CLOUD.token=_tokenFromURL()||_localGet('zs5_ws')||null;
  if(!CLOUD.token){
    _createWS().then(t=>{
      CLOUD.token=t; _localSet('zs5_ws',t); _setURLToken(t); boot();
    }).catch(()=>boot());
  } else { boot(); }
}
```

后端对应接口（`server.js`）：

```js
if (p === '/api/workspace/new' && req.method === 'GET') {
  const token = crypto.randomBytes(12).toString('base64url'); // 16 字符 URL 安全随机令牌
  withLock(token, () => writeWS(token, { data: {}, mt: {} }));
  sendJSON(res, 200, { token });
}
```

端口兼容（`server.js` 顶部）：

```js
const PORT = parseInt(process.env.PORT || '3000', 10); // Render 注入 PORT，本地回退 3000
server.listen(PORT, () => console.log('[zs5-cloud] listening on http://localhost:'+PORT));
```
