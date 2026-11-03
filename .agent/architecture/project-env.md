---
type: architecture
title: Project Env Injection
related:
  - architecture/agent-dispatch
  - context/project-env
---

# Project Env Injection

Project 明碼設定經 main 解析與驗證，注入 Shelf 為該 Project 啟動的 process。

## 資料流

    Canonical Project env → main 解析／驗證 → 單一 env map
      ├─ Terminal → local spawn env／remote shell export
      ├─ Per-tab Agent → local spawn env／remote shell export
      └─ Per-host dispatcher → open_session → per-session exec

## 邊界

- Terminal 與 Agent 共用解析出口；renderer 不直接指定 process 啟動 env。
- Local 將 env 合併到 child；remote 將 env 放進目標端啟動指令，不能只設定本機 client。
- Dispatcher 由同 host 共用，per-project env 必須隨 session 傳遞，替換 exec 時重套。
- Precedence 是 ambient < Project < Shelf-required；PATH 前置合併不取代，保留字由
  輸入驗證與 spawn 注入雙重保護。Terminal 的 BROWSER 指向 Shelf cooperative launcher。
- Project env 是明碼設定，不提供機密加解密或獨立 key／side-car 資料流。
