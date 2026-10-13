# WebLabel

本地服务 + 浏览器的图片标注与 AI 审校工作台：导入图片、编辑检测框和属性、审核固定版本，再导出数据集。人工标注不需要 Python、模型权重、API key 或订阅账号。

本页供使用者判断适用范围并启动应用；完整操作见[入门指南](docs/getting-started.md)，当前能力与验收边界见[能力说明](docs/current-capabilities.md)。

## 标注界面

以下为仓库已有的真实界面截图，使用合成示例图，不含业务数据；展示此前实测界面，不代表最新控件或本轮验收。

画布工作台：图片与对象列表、框选编辑、类别属性、几何输入和服务器保存确认。

![标注工作台：选中的检测框、右侧属性与几何面板，以及“已同步到服务器”状态](docs/images/readme/04-editor-saved.png)

<details>
<summary>查看类别与属性配置截图</summary>

![项目标注规范：类别名称、颜色、快捷键、枚举属性与标注指南](docs/images/readme/02-project-ontology.png)

</details>

## 快速开始

当前需从源码构建，尚无签名 exe 或安装器。已启动服务可直接打开终端显示的 `WEBLABEL_LOCAL_URL`（默认 `http://127.0.0.1:48100`）。

构建已验证环境为 Windows x64；编辑需要桌面 Chrome/Edge 和真实可用的 WebGPU device。先按[构建与启动](docs/getting-started.md#构建与启动)准备固定工具版本，并按[当前终端选择 Node](docs/getting-started.md#当前终端选择-node)设置当前进程 PATH，不修改全局配置。

在仓库根目录依次执行，任一步失败先停止并处理：

```text
pnpm install --frozen-lockfile
pnpm build
pnpm run doctor
pnpm start:local
```

默认发行目录为 `target/local-release`，数据目录为 `data`。重复构建拒绝已有发行目录；另建发行目录的方法见[入门指南](docs/getting-started.md#构建与启动)，不要覆盖旧发行或删除业务数据。`doctor` 只做诊断，不证明浏览器 GPU 或模型可用。

首次启动后，在网页粘贴终端中的一次性 `WEBLABEL_BOOTSTRAP_CODE`，设置并确认密码；普通新库用户名为 `local-admin`。启动码十分钟有效、仅能兑换一次，不要分享启动码或密码。后续使用实际用户名和密码登录。

## 使用边界

- **本机部署**：默认只监听 loopback，不提供公网部署；支持静态 PNG/JPEG 的框与属性标注，本轮不含 Mask、视频和云端。
- **真实画布**：React 界面、Rust/WASM 编辑内核与 wgpu 渲染；无可用 WebGPU 时仅提供诊断或只读界面，不用 Canvas2D 替代。
- **保存与交付**：以“已同步到服务器”为保存确认，本地待同步不等于服务器已保存。空文档不是负样本；审核绑定不可变版本，导出先固定快照并明确确认信息损失。
- **独立审核**：项目默认禁止自审核，团队交付需另一具有项目审核权限的账号；单账号仍可人工编辑和保存。
- **可选 AI**：模型只生成候选，采纳需明确操作且可撤销；外发图片需项目策略、服务端 scope 和用户授权同时满足。Codex 已退役，必需模型渠道尚未全部通过完整验收。
- **未正式发布**：T32 为 blocked，T35 最终发布审查为 pending。仓库为 **UNLICENSED，未授予再分发许可**；构建成功不等于发布验收通过。

## 文档入口

[文档总入口](docs/README.md)维护完整专题目录；按当前动作选择：

- [入门指南](docs/getting-started.md)：登录、规范、导入、编辑、审核与导出。
- [开发指南](docs/development.md) / [恢复入口](START_HERE.md)：准备环境、定位模块、继续开发。
- [运维手册](docs/operations.md) / [备份恢复](docs/backup-restore.md)：账号、服务与数据维护。
- [故障指南](docs/troubleshooting.md) / [已知限制](docs/known-limitations.md)：保全草稿并处理异常。
- [验证说明](docs/verification.md) / [报告索引](reports/index.md)：核对实际证据及未完成的验收条件。
