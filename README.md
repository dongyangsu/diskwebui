# diskwebui · 硬盘检测与格式化 Web 管理平台

> 网页端的硬盘批量检测 / 缺陷判定 / 格式化系统：插盘自动识别 → 缺陷判断 → 自动格式化 → 复检 → 自动续格，支持多台机器统一管理。

![首页](docs/images/01_首页_硬盘与任务.png)

---

## 功能特性

- **多机器管理**：以机器 IP 为入口（`http://机器IP:8090`），支持增删改查、连接测试、在线状态、快速跳转
- **硬盘识别**：品牌（日立/HGST、西数、希捷、东芝）、接口（SAS/SATA/NVMe）、容量、序列号、逻辑/物理块大小
- **缺陷判定**：SAS 判 G-list；SATA 判 SMART `05/196/197`（198/199 不计入）
- **只改逻辑块大小的格式化**：512 / 520 / 4096 / 4160，不涉及文件系统与分区表
- **插盘自动检测 + 自动格式化 + 自动续格**：格完复检仍有缺陷才续格；全局暂停 / 单盘截停互不干扰（主从模型）
- **人工修正优先**：品牌 / 接口 / 缺陷结论 / 块大小均可人工覆盖，自动识别结果同时展示
- **顶部多开命令行**：真 PTY，多标签独立会话
- **多机自动同步**：主服务器为唯一代码源，节点空闲时自动跟版（主源可达时永不使用备用源）
- **安全**：三级角色（viewer/operator/admin）、危险操作二次确认、审计留痕、系统盘/挂载盘默认拦截

---

## 目录结构

```
diskwebui/
├── README.md                 # 本文件：项目说明
├── docs/                     # 项目文档
│   ├── 硬盘检测与格式化 Web 管理界面规划（V0.2 实现版）.md   # 立项→需求→架构→实现→部署→问题→测试→运维
│   └── images/               # 文档插图（界面截图）
├── src/                      # 当前版本源码（可直接部署）
│   ├── server.js             # HTTP(S) 服务、路由、鉴权、调度器
│   ├── lib/                  # detect / rules / exec / autoformat / autoupdate / store ...
│   ├── public/               # 前端 index.html + app.js + style.css（无框架）
│   └── scripts/              # 辅助脚本
└── versions/                 # 历史版本归档（含版本对照表）
    ├── v1.0/diskwebui_v1_src.tar.gz
    └── v2.0/diskwebui_v2_src.tar.gz
```

---

## 版本

| 版本 | 日期 | 说明 |
|---|---|---|
| **v2.0** | 2026-09-20 | 当前修复版。修复 14 个开发期 + 9 个部署期问题；新增插盘自动检测/自动续格（主从模型）；6 层测试体系回归通过 |
| **v1.0** | 2026-09-16 | 第一版。多机管理 + 硬盘检测 + 缺陷判定 + 手工格式化 + 命令行 |

详见 [`versions/README.md`](versions/README.md)。

---

## 快速部署

```bash
# 1) 依赖
sudo apt update && sudo apt install -y smartmontools sg3-utils lsscsi

# 2) 放置代码
mkdir -p ~/disk_webui && cd ~/disk_webui
tar xzf diskwebui_v2_src.tar.gz --strip-components=1     # 或直接拷贝 src/ 下的内容
mkdir -p data                                            # 运行时数据（首次启动生成默认配置）

# 3) 配置 data/settings.json：nodePort=8090、工具路径、admin 账号（上线后请勿再改 admin）

# 4) 常驻服务（root 运行，smartctl 需要）
sudo tee /etc/systemd/system/diskwebui.service >/dev/null <<'EOF'
[Unit]
Description=Disk WebUI
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/<user>/disk_webui
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now diskwebui

# 5) 验证
systemctl is-active diskwebui                                    # active
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/  # 200
```

访问 `http://机器IP:8090`。**完整部署 / 问题排查见文档第七章。**

---

## 文档

[**硬盘检测与格式化 Web 管理界面规划（V0.2 实现版）**](docs/硬盘检测与格式化%20Web%20管理界面规划（V0.2%20实现版）.md)

- 一、立项与项目目标　二、需求分析　三、系统架构　四、功能模块实现
- 五、页面结构与界面　六、代码实现要点　**七、部署手册（照做可上线）**
- **八、开发期问题与解决（14 项）　九、部署期问题与解决（9 项）**
- 十、测试与 Bug 修复（6 层测试体系 + 真机端到端验证）　十一、日常运维与故障处理

---

## 运行环境

| 项 | 要求 |
|---|---|
| 系统 | Ubuntu 20.04+ 等 Linux |
| Node.js | ≥ 18 |
| 必需工具 | smartmontools、sg3-utils、lsscsi |
| 格式化工具 | hugo（日立/HGST）、wdckit（西数）、sg_format / SeaChest（SAS） |
| 端口 | 8090（HTTP）/ 8443（HTTPS） |
