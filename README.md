# Cloudflare Workers 后台任务中继

用户把自己的中继部署到 **自己的 Cloudflare 账号**。棉花糖机官方不接收聊天正文与 API Key；数据只经过用户选择的 Cloudflare 与模型服务商。

## 手机能不能操作？

可以。理想流程约 2–3 分钟：

1. 棉花糖机 → 设置 → 后台任务中继 →「生成并复制访问令牌」（App 自动生成，不用手编）
2. 再点「部署到 Cloudflare」；若部署页没出现 `ADMIN_TOKEN`，到 Worker → Settings → Variables and Secrets 新建 Secret `ADMIN_TOKEN`，粘贴刚才复制的令牌
3. 打开中继 `/setup`，粘贴同一令牌，复制配置回 App 导入并测试（测试会做加密往返自检；改过 `ADMIN_TOKEN` 后必须与 App 里保持同一串）

Cloudflare 授权页在手机浏览器里也能走完，但小屏会挤一些；**有电脑会更顺，不是必须。**

已部署用户若要启用加密自检接口：把本仓库最新代码重新 Deploy 一次即可（`POST /crypto-check`）。

## 一键部署

中继使用独立公开模板仓库，不需要开放棉花糖机主仓库：

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/zznnll588546-wq/marshmallow-cloudflare-relay
```

访问令牌请在棉花糖机内生成并复制。**不要**把模型 API Key 写进 Cloudflare Secret——App 会按当前 API 管理里的线路，把完整请求与上游配置加密成任务包后提交。

## 费用

个人轻量使用常落在 Workers 免费额度内，但长上下文解析会消耗 CPU。Cloudflare Free 的单次请求 CPU 仅约 10ms，长对话更容易撞限。

建议：

- 先试用 Free；
- 若长回复经常失败，把该账号升级到 Workers Paid（约 $5/月）。

政策与额度以 Cloudflare 当前说明为准。

## 本地开发

```bash
cd services/cf-generation-relay
npm i
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填 ADMIN_TOKEN
npx wrangler d1 migrations apply DB --local
npm run dev
```

## 完成通知（Web Push）

部署并跑完最新 D1 迁移后，中继会自动在 D1 生成 VAPID 密钥（也可手动配置 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`）。

在棉花糖机 → 后台任务中继 →「开启完成通知」后，定时任务成功/失败时 Worker 会主动推送；点击通知打开 App 并对账落库。  
**说明**：浏览器 / 主屏幕 PWA 可用；Android 原生 APK 被系统杀掉后通常收不到 Web Push，需要后续接 FCM 一类系统通道。

已部署用户请在本目录执行：

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

## 隐私要点

- 中继部署在用户自己的 Cloudflare 账号
- 官方无法查看任务内容与令牌
- D1 与 Queue 只保存 AES-GCM 密文；Worker 调用模型时会在运行内存中短暂解密
- 这不是针对 Cloudflare 运行环境的端到端加密：Worker 执行请求时必须解密，Cloudflare 仍属于用户选择的数据处理方
- `ADMIN_TOKEN` 同时用于访问鉴权与派生密钥；请使用随机长令牌并妥善备份，丢失或轮换后，旧任务密文将无法恢复
- 请求密文在任务结束后清除；结果密文按 TTL（默认 1 小时）删除
- 定时清理过期行
- 切换 App 内 API 线路无需重新部署 Worker
- App 活跃时会把聊天自动推进编译成版本化定时计划；Cron 到点后即使页面已休眠也会执行
